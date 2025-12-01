// Guard: require auth (with development bypass)
(function ensureAuth() {
  const token = localStorage.getItem('authToken');
  if (!token) {
    // For development: set a demo token if none exists
    console.warn('No auth token found. Setting demo token for development.');
    localStorage.setItem('authToken', 'demo_token');
    localStorage.setItem('authUser', JSON.stringify({ name: 'Demo User', email: 'demo@midwest.local' }));
  }
})();


// The following is the provided dashboard logic (localStorage-backed)
// You can later replace localStorage with backend API calls.

// --------------------------- DATA SLOTS ---------------------------
let products = JSON.parse(localStorage.getItem('products')) || [];
let orders = JSON.parse(localStorage.getItem('orders')) || [];
let suppliers = JSON.parse(localStorage.getItem('suppliers')) || [];
let editProductIndex = null;
let editOrderIndex = null;
let editSupplierIndex = null;
let restockProductIndex = null;
let restockProductIdDirect = null; // when opening modal from server-side table by product id
let restockProductNameDirect = null; // keep product name for direct flow
let orderItems = []; // Store order items for the current order being created/edited
let scannedProducts = []; // Array to accumulate scanned products for in-store sales

// DataTables instances
let inventoryDT = null;
let ordersDT = null;
let suppliersDT = null;

// Load product images in the inventory table
async function loadProductImagesInTable() {
  console.log('Loading product images in table...');
  
  // Get all product image elements in the table
  const imageElements = document.querySelectorAll('[id^="product-image-"]');
  
  for (const imgElement of imageElements) {
    const productId = imgElement.id.replace('product-image-', '');
    
    try {
      // Fetch the image for this product
      const imageData = await fetchProductImage(productId);
      
      if (imageData && imageData.dataUrl) {
        // Update the image source
        imgElement.src = imageData.dataUrl;
        imgElement.style.opacity = '1';
        console.log(`Image loaded for product ${productId}`);
      } else {
        // Keep default image if no image found
        console.log(`No image found for product ${productId}`);
      }
    } catch (error) {
      console.error(`Error loading image for product ${productId}:`, error);
      // Keep default image on error
    }
  }
}

// Enhanced lazy loading for images with better performance and UX
function lazyLoadImages() {
  const lazyImages = document.querySelectorAll('.lazy-image:not(.loading):not(.loaded)');
  
  if (lazyImages.length === 0) return;
  
  const observer = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        
        // Mark as loading to prevent duplicate processing
        img.classList.add('loading');
        img.style.opacity = '0.6';
        
        // Use cached image if available, otherwise preload
        preloadImage(img.dataset.src)
          .then(() => {
            img.src = img.dataset.src;
            img.style.opacity = '1';
            img.classList.remove('lazy-image', 'loading');
            img.classList.add('loaded');
            
            // Add a subtle fade-in effect
            img.style.transition = 'opacity 0.3s ease-in-out';
          })
          .catch(() => {
            img.src = '../assets/images/Midwest.jpg';
            img.style.opacity = '1';
            img.classList.remove('lazy-image', 'loading');
            img.classList.add('loaded', 'fallback');
            
            // Add error indicator
            img.title = 'Image failed to load';
          });
        
        observer.unobserve(img);
      }
    });
  }, {
    rootMargin: '100px 0px', // Start loading 100px before the image comes into view
    threshold: 0.1
  });
  
  lazyImages.forEach(img => {
    // Skip if already processed
    if (img.classList.contains('loading') || img.classList.contains('loaded')) return;
    observer.observe(img);
  });
}

// Image cache management
const imageCache = new Map();
const maxCacheSize = 50; // Maximum number of images to cache

// Preload critical images (first few products)
function preloadCriticalImages() {
  const criticalImages = document.querySelectorAll('.lazy-image');
  const maxPreload = 6; // Preload first 6 images
  
  for (let i = 0; i < Math.min(criticalImages.length, maxPreload); i++) {
    const img = criticalImages[i];
    if (img.dataset.src && !img.classList.contains('loading')) {
      preloadImage(img.dataset.src);
    }
  }
}

// Preload and cache images
function preloadImage(src) {
  if (imageCache.has(src)) {
    return Promise.resolve(imageCache.get(src));
  }
  
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Cache the image
      if (imageCache.size >= maxCacheSize) {
        // Remove oldest entry
        const firstKey = imageCache.keys().next().value;
        imageCache.delete(firstKey);
      }
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

// Clear image cache when memory is low
function clearImageCache() {
  if (imageCache.size > maxCacheSize * 0.8) {
    const entries = Array.from(imageCache.entries());
    const toDelete = entries.slice(0, Math.floor(entries.length * 0.3));
    toDelete.forEach(([key]) => imageCache.delete(key));
  }
}

// Setup infinite scroll for inventory table
function setupInfiniteScroll() {
  const tableContainer = document.querySelector('#inventoryTable_wrapper .dataTables_scrollBody');
  if (!tableContainer) return;
  
  let isLoading = false;
  
  tableContainer.addEventListener('scroll', async function() {
    const { scrollTop, scrollHeight, clientHeight } = this;
    
    // Load more when user is near bottom (within 200px)
    if (scrollTop + clientHeight >= scrollHeight - 200 && !isLoading) {
      isLoading = true;
      
      try {
        // Check if there are more pages to load
        const pageInfo = inventoryDT.page.info();
        if (pageInfo.page < pageInfo.pages - 1) {
          // Load next page
          inventoryDT.page('next').draw('page');
        }
      } catch (error) {
        console.error('Error loading more products:', error);
      } finally {
        isLoading = false;
      }
    }
  });
}

// Limit counts
const DASHBOARD_LOW_STOCK_LIMIT = 20;
const LOW_STOCK_MODAL_LIMIT = 20;
let showAllLowStockInModal = false;
let activeDateFilter = null;
let dashboardLowStockDisplayLimit = DASHBOARD_LOW_STOCK_LIMIT; // Track how many items to show in dashboard

function getLowStockThreshold(product) {
  const t = Number(product.lowStockThreshold || product.low_stock_threshold || 5);
  return Number.isFinite(t) && t > 0 ? t : 5;
}

// --------------------------- UI SECTION SWITCHER ---------------------------
function showSection(id) {
  console.log('showSection called with id:', id);
  document.querySelectorAll('main section').forEach(sec => sec.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
  if (id === 'dashboardSection') updateDashboard();
  if (id === 'analyticsSection') {
    // Sync the analytics date filter with the main date filter
    const analyticsDateFilter = document.getElementById('analyticsDateFilter');
    if (analyticsDateFilter) {
      analyticsDateFilter.value = activeDateFilter || '';
    }
    // Initialize charts first, then load data
    setTimeout(() => {
      if (!comparisonChart) {
        initializeComparisonChart();
      }
      loadTop5Items();
      initializeSalesByItemChart();
      // Load analytics data after charts are initialized
      loadDailySalesSummary();
    }, 100);
  }
  if (id === 'inventorySection') {
    console.log('Rendering inventory section...');
    renderInventory();
  }
  if (id === 'inStoreSalesSection') {
    console.log('Rendering in-store sales section...');
    renderScannedProducts();
  }
  if (id === 'ordersSection') renderOrders();
  if (id === 'suppliersSection') renderSuppliers();
  if (id === 'lowStockSection') {
    console.log('Rendering low stock section...');
    loadAllLowStockItems();
    setupLowStockSearch();
  }
}

// --------------------------- INVENTORY ---------------------------
function renderInventory() {
  console.log('renderInventory called');
  if (!inventoryDT) {
    console.log('Initializing DataTable...');
    $('#inventoryTable').addClass('excel-like');
    inventoryDT = $('#inventoryTable').DataTable({
      paging: true,
      pageLength: 25,
      searching: true,
      info: true,
      dom: 'ltip',
      order: [[0, 'asc']], // Sort by Product name
      columns: [
        { 
          title: 'Product',
          data: 'name'
        },
        { 
          title: 'Category',
          data: 'category'
        },
        { 
          title: 'Description',
          data: 'description',
          render: function(data) {
            return data || 'No description';
          }
        },
        { 
          title: 'Price',
          data: 'price',
          render: function(data) {
            return `₱${Number(data || 0).toFixed(2)}`;
          }
        },
        { 
          title: 'Stock',
          data: 'stock',
          render: function(data) {
            return String(data ?? 0);
          }
        },
        { 
          title: 'Actions', 
          orderable: false,
          data: null,
          render: function(data, type, row) {
            // Use data attribute to avoid issues with product ID in onclick
            const productId = String(row.id || row._id || '');
            return `<button class="edit-product-btn text-blue-600" data-product-id="${productId}">Edit</button>`;
          }
        }
      ],
      serverSide: true,
      processing: true,
      ajax: {
        url: `${window.APP_CONFIG.API_BASE_URL}/products/datatables`,
        type: 'GET',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('authToken')}`
        },
        error: function(xhr, error, thrown) {
          console.error('DataTables Ajax error:', {
            xhr: xhr,
            error: error,
            thrown: thrown,
            url: `${window.APP_CONFIG.API_BASE_URL}/products/datatables`
          });
          
          // Show user-friendly error message
          Swal.fire({ icon: 'error', title: 'Unable to load products', text: 'Unable to load products.' });
        }
      },
      drawCallback: function() {
        // Attach event listeners to edit buttons using event delegation
        $('#inventoryTable').off('click', '.edit-product-btn').on('click', '.edit-product-btn', function() {
          const productId = $(this).data('product-id');
          if (productId) {
            editProductFromTable(productId);
          } else {
            console.error('Product ID not found in data attribute');
            Swal.fire({ icon: 'error', title: 'Error', text: 'Product ID not found. Please try again.' });
          }
        });
        // Lazy load images when table is drawn
        setTimeout(() => {
          lazyLoadImages();
          preloadCriticalImages();
        }, 100);
      }
    });
    console.log('DataTable initialized successfully');
    // Wire custom search input
    const invSearch = document.getElementById('inventorySearch');
    if (invSearch) invSearch.addEventListener('input', () => inventoryDT.search(invSearch.value).draw());
    // Move length dropdown beside the search
    const wrapper = document.getElementById('inventoryControlsLength');
    const lengthNode = document.querySelector('#inventoryTable_wrapper .dataTables_length');
    if (wrapper && lengthNode) wrapper.appendChild(lengthNode);
    
    // Setup infinite scroll
    setupInfiniteScroll();
  } else {
    console.log('DataTable already exists, refreshing...');
    inventoryDT.ajax.reload();
  }
  
  // Render scanned products table when inventory section is shown
  renderScannedProducts();
}

function renderScannedProducts() {
  const tbody = document.querySelector('#scannerProductTable tbody');
  if (!tbody) return;

  const processBtn = document.getElementById('processSaleBtn');
  const clearBtn = document.getElementById('clearScannedBtn');

  if (scannedProducts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-3">Scan a product to add it to in-store sales.</td></tr>';
    if (processBtn) processBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
  } else {
    tbody.innerHTML = scannedProducts.map((product, index) => `
      <tr data-index="${index}">
        <td>${product.name}${product.variantName ? ` (${product.variantName})` : ''}</td>
        <td>${product.barcode || '—'}</td>
        <td>
          <input type="number" 
                 min="1" 
                 max="${product.currentStock || 9999}" 
                 value="${product.quantity}" 
                 class="quantity-input border rounded px-2 py-1 w-20 text-center"
                 data-index="${index}"
                 onchange="updateScannedQuantity(${index}, this.value)">
        </td>
        <td>
          <button onclick="removeScannedProduct(${index})" 
                  class="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm">
            Cancel
          </button>
        </td>
      </tr>
    `).join('');
    if (processBtn) processBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
  }

  const counter = document.getElementById('scannerInventoryCount');
  if (counter) {
    counter.textContent = scannedProducts.length > 0
      ? `Products in In-Store Sales: ${scannedProducts.length}`
      : 'Awaiting scan...';
  }
}

function updateScannedQuantity(index, newQuantity) {
  const qty = parseInt(newQuantity) || 1;
  if (qty < 1) {
    Swal.fire({
      icon: 'warning',
      title: 'Invalid Quantity',
      text: 'Quantity must be at least 1'
    });
    renderScannedProducts();
    return;
  }
  
  const product = scannedProducts[index];
  if (product.currentStock && qty > product.currentStock) {
    Swal.fire({
      icon: 'warning',
      title: 'Insufficient Stock',
      text: `Only ${product.currentStock} available in stock`
    });
    scannedProducts[index].quantity = product.currentStock;
    renderScannedProducts();
    return;
  }
  
  scannedProducts[index].quantity = qty;
}

function removeScannedProduct(index) {
  scannedProducts.splice(index, 1);
  renderScannedProducts();
}

async function handleBarcodeScan(barcodeValue) {
  if (!barcodeValue) return;
  try {
    // Use search endpoint instead of scan to avoid decreasing stock
    const result = await apiFetch('/products/search-barcode', {
      method: 'POST',
      body: JSON.stringify({ barcode: barcodeValue })
    });
    const scannedProduct = result.product;

    if (window.JsBarcode && scannedProduct.barcode) {
      JsBarcode('#scannerBarcode', scannedProduct.barcode, {
        format: 'EAN13',
        width: 2,
        height: 60,
        displayValue: true
      });
    }

    const nameEl = document.getElementById('scannerProductName');
    if (nameEl) {
      nameEl.textContent = `Product Name: ${scannedProduct.name}${scannedProduct.variant ? ` (${scannedProduct.variant.display_name || scannedProduct.variant.name})` : ''}`;
    }

    // Create a unique key for variant products
    const productKey = scannedProduct.variantId 
      ? `${scannedProduct.id}_${scannedProduct.variantId}`
      : scannedProduct.id || scannedProduct.barcode;

    // Check if product already exists in scanned products
    const existingIndex = scannedProducts.findIndex(p => {
      if (p.variantId && scannedProduct.variantId) {
        return p.id === scannedProduct.id && p.variantId === scannedProduct.variantId;
      }
      return p.id === scannedProduct.id || p.barcode === scannedProduct.barcode;
    });

    if (existingIndex >= 0) {
      // Increment quantity if product already scanned
      const currentQty = scannedProducts[existingIndex].quantity;
      const maxStock = scannedProducts[existingIndex].currentStock || 9999;
      if (currentQty < maxStock) {
        scannedProducts[existingIndex].quantity += 1;
      } else {
        Swal.fire({
          icon: 'warning',
          title: 'Stock Limit',
          text: `Only ${maxStock} available in stock`
        });
      }
    } else {
      // Add new product to scanned list with quantity 1
      scannedProducts.push({
        id: scannedProduct.id,
        name: scannedProduct.name,
        barcode: scannedProduct.barcode || barcodeValue.trim(),
        quantity: 1,
        variantId: scannedProduct.variantId || null,
        variantName: scannedProduct.variant ? (scannedProduct.variant.display_name || scannedProduct.variant.name) : null,
        price: scannedProduct.price || scannedProduct.variant?.price || 0,
        currentStock: scannedProduct.currentStock || scannedProduct.stock || 0,
        productKey: productKey
      });
    }

    renderScannedProducts();
  } catch (error) {
    console.error('Barcode scan failed:', error);
    Swal.fire({
      icon: 'error',
      title: 'Scan failed',
      text: error.message || 'Unable to process barcode.'
    });
  }
}

async function processScannedSale() {
  if (scannedProducts.length === 0) {
    Swal.fire({
      icon: 'warning',
      title: 'No Items',
      text: 'Please scan at least one product before processing the sale.'
    });
    return;
  }

  // Build summary for confirmation
  const totalItems = scannedProducts.reduce((sum, p) => sum + p.quantity, 0);
  const totalValue = scannedProducts.reduce((sum, p) => sum + (p.price * p.quantity), 0);
  
  // Get and calculate discount
  const discountInput = document.getElementById('scannerDiscount')?.value.trim() || '';
  let discount = 0;
  if (discountInput) {
    if (discountInput.includes('%')) {
      const percent = parseFloat(discountInput.replace('%', '').trim()) || 0;
      discount = (percent / 100) * totalValue;
    } else {
      discount = parseFloat(discountInput) || 0;
    }
  }
  const netTotal = totalValue - discount;

  // Populate the modal
  const itemsContainer = document.getElementById('saleConfirmationItems');
  const summaryContainer = document.getElementById('saleConfirmationSummary');
  
  if (itemsContainer) {
    itemsContainer.innerHTML = scannedProducts.map(p => `
      <div class="p-2 bg-gray-50 rounded">
        <strong>${p.name}${p.variantName ? ` (${p.variantName})` : ''}</strong><br>
        <span class="text-sm text-gray-600">Quantity: ${p.quantity} × ₱${p.price.toFixed(2)} = ₱${(p.price * p.quantity).toFixed(2)}</span>
      </div>
    `).join('');
  }

  if (summaryContainer) {
    summaryContainer.innerHTML = `
      <p><strong>Total Items:</strong> ${totalItems}</p>
      <p><strong>Subtotal:</strong> ₱${totalValue.toFixed(2)}</p>
      ${discount > 0 ? `<p><strong>Discount:</strong> ₱${discount.toFixed(2)}</p>` : ''}
      <p class="font-semibold text-lg mt-2"><strong>Net Total:</strong> ₱${netTotal.toFixed(2)}</p>
    `;
  }

  // Reset payment method to Cash
  const paymentSelect = document.getElementById('saleConfirmationPayment');
  if (paymentSelect) {
    paymentSelect.value = 'Cash';
  }

  // Show the modal
  const modal = document.getElementById('saleConfirmationModal');
  if (modal) {
    modal.classList.remove('hidden');
  }
}

function closeSaleConfirmationModal() {
  const modal = document.getElementById('saleConfirmationModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function confirmSaleProcessing() {
  // Close the modal
  closeSaleConfirmationModal();

  try {
    // Prepare items for batch processing
    const items = scannedProducts.map(p => ({
      barcode: p.barcode,
      quantity: p.quantity,
      variantId: p.variantId || undefined
    }));

    Swal.fire({
      title: 'Processing...',
      text: 'Please wait while we process your sale.',
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });

    const batchResult = await apiFetch('/products/batch-scan', {
      method: 'POST',
      body: JSON.stringify({ items })
    });

    if (batchResult.success && batchResult.processed > 0) {
      // Create an In-Store order to track this sale
      try {
        // Prepare order items from scanned products
        const orderItems = scannedProducts.map(p => ({
          product_id: p.id, // MongoDB ObjectId from search result
          product_name: p.name, // Store base product name only, variant will be shown separately
          quantity: p.quantity,
          price: p.price,
          total_price: p.price * p.quantity,
          variant_id: p.variantId || null,
          variant_name: p.variantName || null
        }));

        const totalPrice = scannedProducts.reduce((sum, p) => sum + (p.price * p.quantity), 0);
        
        // Calculate discount (reuse the same calculation from above)
        const discountInput = document.getElementById('scannerDiscount')?.value.trim() || '';
        let calculatedDiscount = 0;
        if (discountInput) {
          if (discountInput.includes('%')) {
            const percent = parseFloat(discountInput.replace('%', '').trim()) || 0;
            calculatedDiscount = (percent / 100) * totalPrice;
          } else {
            calculatedDiscount = parseFloat(discountInput) || 0;
          }
        }
        const calculatedNetTotal = totalPrice - calculatedDiscount;

        // Get payment method from modal
        const paymentMethod = document.getElementById('saleConfirmationPayment')?.value || 'Cash';

        // Generate a device ID for in-store sales (use a fixed identifier)
        const inStoreDeviceId = 'INSTORE-' + new Date().getTime();

        // Create the order
        await apiFetch('/orders', {
          method: 'POST',
          body: JSON.stringify({
            name: 'In-Store Sale',
            contact: '',
            address: '',
            payment: paymentMethod,
            ref: null, // No reference number for in-store GCash
            totalPrice: totalPrice,
            discount: calculatedDiscount,
            net_total: calculatedNetTotal,
            status: 'Completed',
            type: 'In-Store',
            device_id: inStoreDeviceId,
            fcm_token: null,
            items: orderItems
          })
        });

        Swal.fire({
          icon: 'success',
          title: 'Sale Processed!',
          html: `
            <p>Successfully processed ${batchResult.processed} item(s).</p>
            <p class="mt-2">Subtotal: ₱${totalPrice.toFixed(2)}</p>
            ${calculatedDiscount > 0 ? `<p>Discount: ₱${calculatedDiscount.toFixed(2)}</p>` : ''}
            <p class="mt-2 font-semibold">Net Total: ₱${calculatedNetTotal.toFixed(2)}</p>
            <p class="text-sm text-gray-600 mt-2">Order created and recorded in In-Store Sales.</p>
            ${batchResult.errorCount && batchResult.errorCount > 0 
              ? `<p class="text-red-600 mt-2">${batchResult.errorCount} error(s) occurred.</p>` 
              : ''}
          `,
          confirmButtonText: 'OK'
        });
      } catch (orderError) {
        console.error('Error creating order:', orderError);
        // Still show success for stock decrease, but warn about order creation
        Swal.fire({
          icon: 'warning',
          title: 'Stock Updated',
          html: `
            <p>Stock has been decreased successfully.</p>
            <p class="text-red-600 mt-2">Warning: Failed to create order record. ${orderError.message || 'Unknown error'}</p>
          `,
          confirmButtonText: 'OK'
        });
      }

      // Clear scanned products
      scannedProducts = [];
      renderScannedProducts();
      
      // Clear discount field
      const discountInput = document.getElementById('scannerDiscount');
      if (discountInput) discountInput.value = '';
      
      // Clear barcode display
      const barcodeEl = document.getElementById('scannerBarcode');
      if (barcodeEl) barcodeEl.innerHTML = '';
      const nameEl = document.getElementById('scannerProductName');
      if (nameEl) nameEl.textContent = '';

      // Refresh inventory and orders
      await loadFromBackend();
      updateDashboard();
      renderInventory();
      renderOrders();
    } else {
      throw new Error('Failed to process some items');
    }
  } catch (error) {
    console.error('Error processing sale:', error);
    Swal.fire({
      icon: 'error',
      title: 'Processing Failed',
      text: error.message || 'An error occurred while processing the sale.'
    });
  }
}

function clearScannedProducts() {
  if (scannedProducts.length === 0) return;

  Swal.fire({
    icon: 'question',
    title: 'Clear All Items?',
    text: 'This will remove all scanned items from the list.',
    showCancelButton: true,
    confirmButtonText: 'Yes, Clear All',
    cancelButtonText: 'Cancel',
    confirmButtonColor: '#ef4444'
  }).then((result) => {
    if (result.isConfirmed) {
      scannedProducts = [];
      renderScannedProducts();
      
      // Clear discount field
      const discountInput = document.getElementById('scannerDiscount');
      if (discountInput) discountInput.value = '';
      
      // Clear barcode display
      const barcodeEl = document.getElementById('scannerBarcode');
      if (barcodeEl) barcodeEl.innerHTML = '';
      const nameEl = document.getElementById('scannerProductName');
      if (nameEl) nameEl.textContent = '';
    }
  });
}

function setupScannerInputListener() {
  const input = document.getElementById('scannerBarcodeInput');
  if (!input) return;

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const value = event.target.value.trim();
      if (value) {
        handleBarcodeScan(value);
        event.target.value = '';
      }
    }
  });
}

// Export inventory to CSV (Excel friendly)
function exportInventoryCSV() {
  try {
    fetchAllProducts()
      .then(list => {
        const rows = list.map(p => [
          p.id, p.name, p.category || '', p.description || '', Number(p.price || 0), Number(p.stock || 0)
        ]);
        const header = ['ID','Product','Category','Description','Price','Stock'];
        const csv = [header].concat(rows)
          .map(r => r.map(v => String(v).replace(/"/g,'""')).map(v=>`"${v}"`).join(','))
          .join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `inventory-${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
  } catch (_) {}
}

// Export inventory to simple PDF using browser print-to-pdf
function exportInventoryPDF() {
  try {
    fetchAllProducts()
      .then(list => {
        const rows = list.map(p =>
          `<tr><td>${p.name}</td><td>${p.category || ''}</td><td class=\"num\">₱${Number(p.price||0).toFixed(2)}</td><td class=\"num\">${Number(p.stock||0)}</td></tr>`
        ).join('');
        const styles = `body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial} table{width:100%;border-collapse:collapse} th,td{border:1px solid #e5e7eb;padding:6px 8px;font-size:12px} th{background:#f3f4f6;text-align:left} td.num,th.num{text-align:right}`;
        const html = `<h2>Inventory</h2><table><thead><tr><th>Product</th><th>Category</th><th class=\"num\">Price</th><th class=\"num\">Stock</th></tr></thead><tbody>${rows}</tbody></table>`;
        const w = window.open('', '', 'width=900,height=700');
        w.document.write(`<html><head><title>Inventory</title><style>${styles}</style></head><body>${html}</body></html>`);
        w.document.close(); w.focus(); w.print();
      });
  } catch (_) {}
}

// Table action functions (for server-side pagination)
async function editProductFromTable(productId) {
  try {
    // Validate product ID format (MongoDB ObjectId is 24 hex characters)
    if (!productId || typeof productId !== 'string' || productId.length !== 24) {
      console.error('Invalid product ID format:', productId);
      Swal.fire({ icon: 'error', title: 'Invalid product ID', text: 'The product ID is invalid or corrupted.' });
      return;
    }
    
    console.log('editProductFromTable called with productId:', productId);
    const response = await apiFetch(`/products/${productId}`);
    const product = response.product;
    
    editProductIndex = null; // We'll handle this differently for server-side
    document.getElementById('productModalTitle').innerText = "Edit Product";
    document.getElementById('prodName').value = product.name;
    document.getElementById('prodCategory').value = product.category || '';
    document.getElementById('prodBarcode').value = product.barcode || '';
    document.getElementById('prodDescription').value = product.description || '';
    document.getElementById('prodPrice').value = product.price || '';
    document.getElementById('prodStock').value = product.stock || '';
    
    // Load variants if they exist
    const variantsContainer = document.getElementById('variantsContainer');
    if (variantsContainer) {
      variantsContainer.innerHTML = '';
      
      if (product.variants && Array.isArray(product.variants) && product.variants.length > 0) {
        product.variants.forEach(variant => {
          addVariant(variant);
        });
      }
      updateLegacyFieldsVisibility();
    }
    
    // Store the product ID for saving and enable extra actions in modal
    const modal = document.getElementById('productModal');
    if (modal) {
      modal.setAttribute('data-product-id', productId);
    }
    const receiveBtn = document.getElementById('editReceiveBtn');
    const deleteBtn = document.getElementById('editDeleteBtn');
    if (receiveBtn) receiveBtn.classList.remove('hidden');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
    
    // Fetch and display the existing image from MongoDB
    await displayProductImage(productId, 'productImagePreviewImg');
    
    // Show the image preview section
    const preview = document.getElementById('productImagePreview');
    const upload = document.getElementById('productImageUpload');
    if (preview && upload) {
      preview.classList.remove('hidden');
      upload.classList.add('hidden');
    }
    
    document.getElementById('productModal').classList.remove('hidden');
  } catch (error) {
    console.error('Failed to load product:', error);
    Swal.fire({ icon: 'error', title: 'Failed to load product details' });
  }
}

async function deleteProductFromTable(productId) {
  console.log('deleteProductFromTable called with productId:', productId);
  const { isConfirmed } = await Swal.fire({ icon: 'warning', title: 'Delete product?', text: 'This action cannot be undone.', showCancelButton: true, confirmButtonText: 'Delete' });
  if (!isConfirmed) return;
  
  try {
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to delete product');
    }
    
    const result = await response.json();
    console.log('Product deletion result:', result);
    
    // Refresh the table
    inventoryDT.ajax.reload();
    Swal.fire({ icon: 'success', title: 'Product deleted successfully', text: `Deleted: ${result.deletedProduct?.name || 'Product'}` });
  } catch (error) {
    console.error('Failed to delete product:', error);
    Swal.fire({ icon: 'error', title: 'Failed to delete product', text: String(error.message || '') });
  }
}

async function openRestockModalFromTable(productId) {
  console.log('openRestockModalFromTable called with productId:', productId);
  try {
    const res = await apiFetch(`/products/${productId}`);
    const product = res.product || {};
    restockProductIndex = null; // use direct id flow
    restockProductIdDirect = product.id || productId;
    restockProductNameDirect = product.name || null;
    
    // Update product name display
    const stockDisplay = product.variants && product.variants.length > 0
      ? `Total: ${Number(product.stock || 0)}`
      : `current: ${Number(product.stock || 0)}`;
    document.getElementById('restockProductName').textContent = `${product.name || ('#' + productId)} (${stockDisplay})`;
    
    // Handle variants
    const variantSection = document.getElementById('restockVariantSection');
    const variantSelect = document.getElementById('restockVariant');
    const variantStockInfo = document.getElementById('restockVariantStock');
    
    if (product.variants && product.variants.length > 0) {
      // Show variant selection
      variantSection.classList.remove('hidden');
      variantSelect.innerHTML = '<option value="">-- Select Variant --</option>';
      
      product.variants.forEach(variant => {
        const option = document.createElement('option');
        option.value = variant._id || '';
        // Construct variant display name
        let variantName = variant.name || '';
        if (!variantName) {
          const parts = [];
          if (variant.option1_value) parts.push(variant.option1_value);
          if (variant.option2_value) parts.push(variant.option2_value);
          if (variant.option3_value) parts.push(variant.option3_value);
          variantName = parts.length > 0 ? parts.join(' / ') : 'Unnamed Variant';
        }
        option.textContent = `${variantName} (Stock: ${variant.stock || 0})`;
        option.setAttribute('data-stock', variant.stock || 0);
        variantSelect.appendChild(option);
      });
      
      // Update stock info when variant is selected (remove old listeners first)
      const newSelect = variantSelect.cloneNode(true);
      variantSelect.parentNode.replaceChild(newSelect, variantSelect);
      document.getElementById('restockVariant').addEventListener('change', function() {
        const selectedOption = this.options[this.selectedIndex];
        if (selectedOption.value) {
          const stock = selectedOption.getAttribute('data-stock') || 0;
          variantStockInfo.textContent = `Current stock: ${stock}`;
        } else {
          variantStockInfo.textContent = '';
        }
      });
    } else {
      // Hide variant selection for products without variants
      variantSection.classList.add('hidden');
      variantSelect.innerHTML = '<option value="">-- Select Variant --</option>';
      variantStockInfo.textContent = '';
    }
    
    document.getElementById('restockQty').value = '';
    document.getElementById('restockDate').value = new Date().toISOString().slice(0,10);
    populateRestockSuppliersSelect();
    document.getElementById('restockModal').classList.remove('hidden');
  } catch (_e) {
    Swal.fire({ icon: 'error', title: 'Unable to open restock modal' });
  }
}

async function fetchProductImageFromTable(productId) {
  console.log('fetchProductImageFromTable called with productId:', productId);
  
  try {
    Swal.fire({
      title: 'Fetching Image...',
      text: 'Please wait while we fetch the image from the database',
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });
    
    const imageData = await fetchProductImage(productId);
    
    if (imageData && imageData.dataUrl) {
      // Show the fetched image in a modal
      Swal.close();
      Swal.fire({
        title: 'Product Image',
        html: `<img src="${imageData.dataUrl}" alt="Product Image" style="max-width: 100%; max-height: 400px; object-fit: contain;">`,
        showConfirmButton: true,
        confirmButtonText: 'Close',
        width: 'auto'
      });
    } else {
      Swal.close();
      Swal.fire({ 
        icon: 'info', 
        title: 'No Image Found', 
        text: 'This product does not have an image in the database' 
      });
    }
  } catch (error) {
    console.error('Error fetching product image:', error);
    Swal.close();
    Swal.fire({ 
      icon: 'error', 
      title: 'Failed to Fetch Image', 
      text: 'Could not load image from database' 
    });
  }
}

async function deleteProductImageFromTable(productId) {
  console.log('deleteProductImageFromTable called with productId:', productId);
  const { isConfirmed } = await Swal.fire({ icon: 'warning', title: 'Remove product image?', text: 'This will permanently delete the image from Cloudinary.', showCancelButton: true, confirmButtonText: 'Remove' });
  if (!isConfirmed) return;
  
  try {
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}/image`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Image deletion failed');
    }
    
    const result = await response.json();
    console.log('Image deletion result:', result);
    
    // Refresh the table
    inventoryDT.ajax.reload();
    Swal.fire({ icon: 'success', title: 'Image removed', text: 'Image deleted from Cloudinary successfully' });
  } catch (error) {
    console.error('Image deletion failed:', error);
    Swal.fire({ icon: 'error', title: 'Failed to remove image', text: String(error.message || '') });
  }
}

// Variant management functions
let variantCounter = 0;

function addVariant(variantData = null) {
  const container = document.getElementById('variantsContainer');
  const variantId = variantData?._id || `variant_${variantCounter++}`;
  
  const variantDiv = document.createElement('div');
  variantDiv.className = 'border rounded p-3 bg-gray-50';
  variantDiv.id = `variant_${variantId}`;
  
  variantDiv.innerHTML = `
    <div class="flex justify-between items-center mb-2">
      <span class="text-sm font-semibold text-gray-700">Variant</span>
      <button type="button" onclick="removeVariant('${variantId}')" class="text-red-600 hover:text-red-800 text-sm">Remove</button>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-2">
      <div>
        <label class="block text-xs text-gray-600 mb-1">Name</label>
        <input type="text" class="variant-name border rounded w-full px-2 py-1 text-sm" placeholder="e.g., Small" value="${variantData?.name || ''}">
      </div>
      <div>
        <label class="block text-xs text-gray-600 mb-1">SKU</label>
        <input type="text" class="variant-sku border rounded w-full px-2 py-1 text-sm" placeholder="SKU" value="${variantData?.sku || ''}">
      </div>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-2">
      <div>
        <label class="block text-xs text-gray-600 mb-1">Cost</label>
        <input type="number" step="0.01" class="variant-cost border rounded w-full px-2 py-1 text-sm" placeholder="0.00" value="${variantData?.cost || ''}">
      </div>
      <div>
        <label class="block text-xs text-gray-600 mb-1">Stock</label>
        <input type="number" class="variant-stock border rounded w-full px-2 py-1 text-sm" placeholder="0" value="${variantData?.stock || ''}" required>
      </div>
    </div>
    <div class="mb-2">
      <label class="block text-xs text-gray-600 mb-1">Price</label>
      <input type="number" step="0.01" class="variant-price border rounded w-full px-2 py-1 text-sm" placeholder="0.00" value="${variantData?.price || ''}" required>
    </div>
    <div class="mb-2">
      <label class="block text-xs text-gray-600 mb-1">Barcodes (one per line)</label>
      <textarea class="variant-barcodes border rounded w-full px-2 py-1 text-sm" rows="2" placeholder="Enter barcodes, one per line">${variantData?.barcodes?.join('\n') || ''}</textarea>
    </div>
    <!-- Variant Image Section -->
    <div class="mb-2">
      <label class="block text-xs text-gray-600 mb-1">Variant Image</label>
      <div class="border border-gray-300 rounded p-2">
        <div id="variant-image-preview-${variantId}" class="mb-2 ${variantData?.image_url ? '' : 'hidden'}">
          <img id="variant-image-img-${variantId}" src="${variantData?.image_url || '../assets/images/Midwest.jpg'}" alt="Variant preview" class="mx-auto max-h-20 max-w-20 object-contain rounded">
          <div class="mt-1 space-x-2 text-center">
            <button type="button" onclick="removeVariantImage('${variantId}')" class="text-red-600 text-xs hover:text-red-800">Remove</button>
          </div>
        </div>
        <div id="variant-image-upload-${variantId}" class="${variantData?.image_url ? 'hidden' : ''}">
          <input type="file" id="variant-image-input-${variantId}" accept="image/*" class="hidden" onchange="handleVariantImageSelect(event, '${variantId}')">
          <button type="button" onclick="document.getElementById('variant-image-input-${variantId}').click()" class="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"><i class="bi bi-camera"></i> Upload Image</button>
        </div>
        <input type="hidden" class="variant-image-url" value="${variantData?.image_url || ''}">
        <input type="hidden" class="variant-image-public-id" value="${variantData?.image_public_id || ''}">
      </div>
    </div>
  `;
  
  container.appendChild(variantDiv);
  updateLegacyFieldsVisibility();
}

function removeVariant(variantId) {
  const variantDiv = document.getElementById(`variant_${variantId}`);
  if (variantDiv) {
    variantDiv.remove();
    updateLegacyFieldsVisibility();
  }
}

function updateLegacyFieldsVisibility() {
  const container = document.getElementById('variantsContainer');
  const legacyFields = document.getElementById('legacyFields');
  const hasVariants = container && container.children.length > 0;
  
  if (legacyFields) {
    if (hasVariants) {
      legacyFields.classList.add('hidden');
    } else {
      legacyFields.classList.remove('hidden');
    }
  }
}

function getVariantsData() {
  const container = document.getElementById('variantsContainer');
  if (!container || container.children.length === 0) {
    return null;
  }
  
  const variants = [];
  const variantDivs = container.querySelectorAll('[id^="variant_"]');
  
  variantDivs.forEach(div => {
    const name = div.querySelector('.variant-name')?.value?.trim() || null;
    const sku = div.querySelector('.variant-sku')?.value?.trim() || null;
    const cost = parseFloat(div.querySelector('.variant-cost')?.value) || 0;
    const price = parseFloat(div.querySelector('.variant-price')?.value) || 0;
    const stock = parseInt(div.querySelector('.variant-stock')?.value) || 0;
    const barcodesText = div.querySelector('.variant-barcodes')?.value?.trim() || '';
    const barcodes = barcodesText.split('\n').map(b => b.trim()).filter(b => b);
    const imageUrl = div.querySelector('.variant-image-url')?.value?.trim() || null;
    const imagePublicId = div.querySelector('.variant-image-public-id')?.value?.trim() || null;
    
    // Get variant ID if editing
    const variantId = div.id.replace('variant_', '');
    const isNewVariant = !variantId.startsWith('variant_') && variantId !== '';
    
    // Always include variants that are in the container (user has added them)
    // Barcodes are optional - send empty array if no barcodes entered
    // Backend will validate required fields (price, stock)
    const variantData = {
      name,
      sku,
      cost,
      price,
      stock,
      barcodes: barcodes.length > 0 ? barcodes : [], // Send empty array if no barcodes
      image_url: imageUrl,
      image_public_id: imagePublicId
    };
    
    // Include _id if editing existing variant
    if (!isNewVariant && variantId && !variantId.startsWith('variant_')) {
      variantData._id = variantId;
    }
    
    variants.push(variantData);
  });
  
  return variants.length > 0 ? variants : null;
}

// Product modal functions
function openAddProductModal() {
  console.log('openAddProductModal called');
  editProductIndex = null;
  document.getElementById('productModalTitle').innerText = "Add Product";
  document.getElementById('prodName').value = '';
  document.getElementById('prodCategory').value = '';
  document.getElementById('prodBarcode').value = '';
  document.getElementById('prodDescription').value = '';
  document.getElementById('prodPrice').value = '';
  document.getElementById('prodStock').value = '';
  
  // Clear variants
  const variantsContainer = document.getElementById('variantsContainer');
  if (variantsContainer) {
    variantsContainer.innerHTML = '';
  }
  updateLegacyFieldsVisibility();
  
  resetProductImage();
  const modal = document.getElementById('productModal');
  console.log('Product modal element:', modal);
  if (modal) {
    // Clear any previous product-id and hide extra action buttons (receive/delete)
    modal.removeAttribute('data-product-id');
    const receiveBtn = document.getElementById('editReceiveBtn');
    const deleteBtn = document.getElementById('editDeleteBtn');
    if (receiveBtn) receiveBtn.classList.add('hidden');
    if (deleteBtn) deleteBtn.classList.add('hidden');
    modal.classList.remove('hidden');
    console.log('Product modal should be visible now');
  } else {
    console.error('Product modal element not found');
  }
}

async function editProduct(i) {
  editProductIndex = i;
  const p = products[i];
  document.getElementById('productModalTitle').innerText = "Edit Product";
  document.getElementById('prodName').value = p.name;
  document.getElementById('prodCategory').value = p.category || '';
  document.getElementById('prodBarcode').value = p.barcode || '';
  document.getElementById('prodDescription').value = p.description || '';
  document.getElementById('prodPrice').value = p.price || '';
  document.getElementById('prodStock').value = p.stock || '';
  
  // Load variants if they exist
  const variantsContainer = document.getElementById('variantsContainer');
  if (variantsContainer) {
    variantsContainer.innerHTML = '';
    
    if (p.variants && Array.isArray(p.variants) && p.variants.length > 0) {
      p.variants.forEach(variant => {
        addVariant(variant);
      });
    }
    updateLegacyFieldsVisibility();
  }
  
  // Load existing image if available
  if (p.image_url) {
    showProductImagePreview(p.image_url);
  } else {
    resetProductImage();
  }
  
  // Set product ID for update
  const modal = document.getElementById('productModal');
  if (modal && p.id) {
    modal.setAttribute('data-product-id', p.id);
    const receiveBtn = document.getElementById('editReceiveBtn');
    const deleteBtn = document.getElementById('editDeleteBtn');
    if (receiveBtn) receiveBtn.classList.remove('hidden');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
  }
  
  document.getElementById('productModal').classList.remove('hidden');
}

async function saveProduct() {
  const name = document.getElementById('prodName').value.trim();
  const category = document.getElementById('prodCategory').value.trim();
  const barcode = document.getElementById('prodBarcode').value.trim();
  const description = document.getElementById('prodDescription').value.trim();
  const price = parseFloat(document.getElementById('prodPrice').value) || 0;
  const stock = parseInt(document.getElementById('prodStock').value) || 0;
  const imageFile = document.getElementById('productImageInput').files[0];

  if (!name) { Swal.fire({ icon: 'warning', title: 'Product name required' }); return; }

  // Get variants data
  const variants = getVariantsData();
  
  // Prepare product data
  const productData = {
    name,
    category: category || null,
    description: description || null
  };
  
  if (variants) {
    productData.variants = variants;
  } else {
    // Legacy mode - use single product fields
    productData.price = price;
    productData.stock = stock;
    productData.barcode = barcode || null;
  }

  // Check if we're editing an existing product (server-side)
  const productId = document.getElementById('productModal')?.getAttribute('data-product-id');
  
  if (productId) {
    // Validate product ID format
    if (typeof productId !== 'string' || productId.length !== 24) {
      console.error('Invalid product ID format:', productId);
      Swal.fire({ icon: 'error', title: 'Invalid product ID', text: 'The product ID is invalid. Please try editing the product again.' });
      return;
    }
    
    // Editing existing product
    try {
      const res = await apiFetch(`/products/${productId}`, { 
        method: 'PATCH', 
        body: JSON.stringify(productData) 
      });
      
      // Handle image upload if new image selected
      if (imageFile) {
        try {
          await uploadProductImage(productId, imageFile);
        } catch (error) {
          console.error('Image upload failed:', error);
          Swal.fire({ icon: 'warning', title: 'Product saved', text: 'Image upload failed' });
        }
      }
      
      // Handle variant image uploads
      if (variants && res.product && res.product.variants) {
        await uploadVariantImages(productId, res.product.variants);
      }
      
      // Refresh the table
      inventoryDT.ajax.reload();
      Swal.fire({ icon: 'success', title: 'Product updated successfully' });
    } catch (error) {
      console.error('Product update failed:', error);
      Swal.fire({ icon: 'error', title: 'Failed to update product', text: error.message || 'Unknown error' });
    }
  } else {
    // Adding new product
    try {
      // Create product via API
      const res = await apiFetch('/products', { 
        method: 'POST', 
        body: JSON.stringify(productData) 
      });
      
      const newProduct = res.product;
      
      // Handle image upload if image selected
      if (imageFile) {
        try {
          await uploadProductImage(newProduct.id, imageFile);
        } catch (error) {
          console.error('Image upload failed:', error);
          Swal.fire({ icon: 'warning', title: 'Product saved', text: 'Image upload failed' });
        }
      }
      
      // Handle variant image uploads
      if (variants && newProduct.variants) {
        await uploadVariantImages(newProduct.id, newProduct.variants);
      }
      
      // Refresh the table
      inventoryDT.ajax.reload();
      Swal.fire({ icon: 'success', title: 'Product added successfully' });
    } catch (error) {
      console.error('Product creation failed:', error);
      Swal.fire({ icon: 'error', title: 'Failed to create product', text: error.message || 'Unknown error' });
    }
  }
  
  closeProductModal();
  updateDashboard();
}

// Consolidated actions inside Edit Product modal
function openRestockFromModal() {
  const modal = document.getElementById('productModal');
  const productId = modal && modal.getAttribute('data-product-id');
  if (!productId) return;
  closeProductModal();
  openRestockModalFromTable(productId);
}

async function deleteProductFromModal() {
  const modal = document.getElementById('productModal');
  const productId = modal && modal.getAttribute('data-product-id');
  if (!productId) return;
  await deleteProductFromTable(productId);
  closeProductModal();
}

// Fetch existing image from MongoDB for a product
async function fetchProductImage(productId) {
  try {
    // Validate product ID before making request
    if (!productId || typeof productId !== 'string' || productId.length !== 24) {
      console.error('Invalid product ID in fetchProductImage:', productId);
      return null;
    }
    
    console.log('Fetching image for product:', productId);
    
    // Get image URL from Cloudinary
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}/image`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        console.log('No image found for product:', productId);
        return null;
      }
      throw new Error(`Failed to fetch image: ${response.status}`);
    }
    
    const imageData = await response.json();
    console.log('Cloudinary image URL fetched successfully');
    
    return {
      dataUrl: imageData.image_url,
      imageUrl: imageData.image_url,
      publicId: imageData.public_id,
      source: 'cloudinary'
    };
  } catch (error) {
    console.error('Error fetching product image:', error);
    return null;
  }
}

// Display fetched image in the UI
async function displayProductImage(productId, targetElementId) {
  try {
    const imageData = await fetchProductImage(productId);
    
    if (imageData && imageData.dataUrl) {
      // Update the target element with the fetched image
      const targetElement = document.getElementById(targetElementId);
      if (targetElement) {
        targetElement.src = imageData.dataUrl;
        targetElement.style.display = 'block';
        console.log('Image displayed successfully');
      }
    } else {
      console.log('No image available for this product');
      // Show default image or placeholder
      const targetElement = document.getElementById(targetElementId);
      if (targetElement) {
        targetElement.src = '../assets/images/Midwest.jpg';
        targetElement.style.display = 'block';
      }
    }
  } catch (error) {
    console.error('Error displaying product image:', error);
  }
}

// Fetch image for the currently selected product in the modal
async function fetchCurrentProductImage() {
  const productId = document.getElementById('productModal').getAttribute('data-product-id');
  
  if (!productId) {
    Swal.fire({ 
      icon: 'warning', 
      title: 'No Product Selected', 
      text: 'Please select a product first' 
    });
    return;
  }
  
  try {
    Swal.fire({
      title: 'Fetching Image...',
      text: 'Please wait while we fetch the image from the database',
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });
    
    await displayProductImage(productId, 'productImagePreviewImg');
    
    // Show the image preview section
    const preview = document.getElementById('productImagePreview');
    const upload = document.getElementById('productImageUpload');
    if (preview && upload) {
      preview.classList.remove('hidden');
      upload.classList.add('hidden');
    }
    
    Swal.close();
    Swal.fire({ 
      icon: 'success', 
      title: 'Image Fetched', 
      text: 'Image has been loaded from the database' 
    });
  } catch (error) {
    console.error('Error fetching current product image:', error);
    Swal.close();
    Swal.fire({ 
      icon: 'error', 
      title: 'Failed to Fetch Image', 
      text: 'Could not load image from database' 
    });
  }
}

// Upload variant images
async function uploadVariantImages(productId, savedVariants) {
  const container = document.getElementById('variantsContainer');
  if (!container) return;
  
  const variantDivs = container.querySelectorAll('[id^="variant_"]');
  
  for (const div of variantDivs) {
    const variantId = div.id.replace('variant_', '');
    const imageBlob = div.getAttribute('data-image-blob');
    
    if (imageBlob) {
      try {
        // Find matching saved variant by name or index
        const variantName = div.querySelector('.variant-name')?.value?.trim();
        const variantIndex = Array.from(variantDivs).indexOf(div);
        const savedVariant = savedVariants.find((v, idx) => 
          (variantName && v.name === variantName) || idx === variantIndex
        ) || savedVariants[variantIndex];
        
        if (savedVariant && savedVariant._id) {
          // Convert data URL to blob
          const response = await fetch(imageBlob);
          const blob = await response.blob();
          
          // Upload variant image
          await uploadVariantImage(productId, savedVariant._id, blob);
          
          // Clear stored image data
          div.removeAttribute('data-image-blob');
          div.removeAttribute('data-image-file');
        }
      } catch (error) {
        console.error(`Failed to upload image for variant ${variantId}:`, error);
      }
    }
  }
}

async function uploadVariantImage(productId, variantId, imageFile) {
  try {
    const formData = new FormData();
    formData.append('image', imageFile);
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}/variants/${variantId}/image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Variant image upload failed: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Variant image upload successful:', result);
    
    // Update variant div with new image URL
    const variantDiv = document.querySelector(`[id^="variant_"][data-variant-id="${variantId}"]`);
    if (variantDiv && result.variant) {
      const imageUrlInput = variantDiv.querySelector('.variant-image-url');
      const imagePublicIdInput = variantDiv.querySelector('.variant-image-public-id');
      const previewImg = variantDiv.querySelector(`#variant-image-img-${variantDiv.id.replace('variant_', '')}`);
      
      if (imageUrlInput) imageUrlInput.value = result.variant.image_url || '';
      if (imagePublicIdInput) imagePublicIdInput.value = result.variant.image_public_id || '';
      if (previewImg && result.variant.image_url) {
        previewImg.src = result.variant.image_url;
      }
    }
    
    return result;
  } catch (error) {
    console.error('Variant image upload error:', error);
    throw error;
  }
}

async function uploadProductImage(productId, imageFile) {
  try {
    console.log('Uploading image for product:', productId);
    console.log('Original file size:', Math.round(imageFile.size / 1024), 'KB');
    
    // Check file size (5MB limit)
    const maxSize = 5 * 1024 * 1024; // 5MB in bytes
    if (imageFile.size > maxSize) {
      throw new Error(`Image file too large. Maximum size is 5MB. Current size: ${Math.round(imageFile.size / 1024 / 1024 * 100) / 100}MB`);
    }
    
    // Upload directly to Cloudinary via server
    const formData = new FormData();
    formData.append('image', imageFile);
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}/image`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Cloudinary upload failed:', response.status, errorText);
      throw new Error(`Image upload failed: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('Cloudinary upload successful:', result);
    
    // Update local product with new image URL
    const productIndex = products.findIndex(p => p.id === productId);
    if (productIndex !== -1) {
      products[productIndex].image_url = result.product.image_url;
      localStorage.setItem('products', JSON.stringify(products));
    }
    
    return result;
  } catch (error) {
    console.error('Image upload error:', error);
    throw error;
  }
}

// Image compression function
function compressImage(file, quality = 0.8, maxWidth = 800) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      // Calculate new dimensions
      let { width, height } = img;
      if (width > maxWidth) {
        height = (height * maxWidth) / width;
        width = maxWidth;
      }
      
      // Set canvas dimensions
      canvas.width = width;
      canvas.height = height;
      
      // Draw and compress
      ctx.drawImage(img, 0, 0, width, height);
      
      // Convert to base64 with compression
      const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve(compressedDataUrl);
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

async function deleteProductImage(productIndex) {
  const product = products[productIndex];
  if (!product || !product.id) {
    Swal.fire({ icon: 'error', title: 'Product not found' });
    return;
  }
  
  if (!confirm('Remove image from this product? This will permanently delete the image from Cloudinary.')) return;
  
  try {
    console.log(`Deleting image for product ${product.id} (${product.name})`);
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${product.id}/image`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Image deletion failed');
    }
    
    const result = await response.json();
    console.log('Image deletion result:', result);
    
    // Update local product to remove image
    products[productIndex].image_url = null;
    localStorage.setItem('products', JSON.stringify(products));
    
    // Refresh the inventory display
    renderInventory();
    Swal.fire({ icon: 'success', title: 'Image removed', text: 'Image deleted from Cloudinary successfully' });
  } catch (error) {
    console.error('Image deletion failed:', error);
    Swal.fire({ icon: 'error', title: 'Failed to remove image', text: String(error.message || '') });
  }
}

function deleteProduct(i) {
  if (!confirm('Delete this product?')) return;
  products.splice(i, 1);
  localStorage.setItem('products', JSON.stringify(products));
  saveToBackend();
  renderInventory();
  updateDashboard();
}

function closeProductModal() {
  // Clear variants when closing
  const variantsContainer = document.getElementById('variantsContainer');
  if (variantsContainer) {
    variantsContainer.innerHTML = '';
  }
  updateLegacyFieldsVisibility();
  console.log('closeProductModal called');
  const modal = document.getElementById('productModal');
  if (modal) {
    modal.classList.add('hidden');
    console.log('Product modal should be hidden now');
  } else {
    console.error('Product modal element not found');
  }
}

// Image handling functions
function handleProductImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  // Validate file type
  if (!file.type.startsWith('image/')) {
    Swal.fire({ icon: 'warning', title: 'Please select an image file' });
    return;
  }
  
  // Validate file size (5MB limit)
  const maxSize = 5 * 1024 * 1024; // 5MB in bytes
  if (file.size > maxSize) {
    Swal.fire({ 
      icon: 'warning', 
      title: 'File too large', 
      text: `File size must be less than 5MB. Current size: ${Math.round(file.size / 1024 / 1024 * 100) / 100}MB` 
    });
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    showProductImagePreview(e.target.result);
  };
  reader.readAsDataURL(file);
}

function showProductImagePreview(imageSrc) {
  const preview = document.getElementById('productImagePreview');
  const previewImg = document.getElementById('productImagePreviewImg');
  const upload = document.getElementById('productImageUpload');
  
  // Set image source directly (base64 or URL)
  previewImg.src = imageSrc;
  previewImg.alt = 'Product Image';
  
  preview.classList.remove('hidden');
  upload.classList.add('hidden');
}

// Variant image handling functions
function handleVariantImageSelect(event, variantId) {
  const file = event.target.files[0];
  if (!file) return;
  
  // Validate file type
  if (!file.type.startsWith('image/')) {
    Swal.fire({ icon: 'warning', title: 'Please select an image file' });
    return;
  }
  
  // Validate file size (5MB limit)
  const maxSize = 5 * 1024 * 1024; // 5MB in bytes
  if (file.size > maxSize) {
    Swal.fire({ 
      icon: 'warning', 
      title: 'File too large', 
      text: `File size must be less than 5MB. Current size: ${Math.round(file.size / 1024 / 1024 * 100) / 100}MB` 
    });
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    showVariantImagePreview(variantId, e.target.result);
    // Store file for later upload
    const variantDiv = document.getElementById(`variant_${variantId}`);
    if (variantDiv) {
      variantDiv.setAttribute('data-image-file', JSON.stringify({
        name: file.name,
        size: file.size,
        type: file.type
      }));
      variantDiv.setAttribute('data-image-blob', e.target.result);
    }
  };
  reader.readAsDataURL(file);
}

function showVariantImagePreview(variantId, imageSrc) {
  const preview = document.getElementById(`variant-image-preview-${variantId}`);
  const previewImg = document.getElementById(`variant-image-img-${variantId}`);
  const upload = document.getElementById(`variant-image-upload-${variantId}`);
  
  if (preview && previewImg && upload) {
    previewImg.src = imageSrc;
    preview.classList.remove('hidden');
    upload.classList.add('hidden');
  }
}

function removeVariantImage(variantId) {
  const preview = document.getElementById(`variant-image-preview-${variantId}`);
  const previewImg = document.getElementById(`variant-image-img-${variantId}`);
  const upload = document.getElementById(`variant-image-upload-${variantId}`);
  const input = document.getElementById(`variant-image-input-${variantId}`);
  const variantDiv = document.getElementById(`variant_${variantId}`);
  
  if (preview && previewImg && upload && input && variantDiv) {
    // Reset to default
    previewImg.src = '../assets/images/Midwest.jpg';
    preview.classList.add('hidden');
    upload.classList.remove('hidden');
    input.value = '';
    
    // Clear stored image data
    variantDiv.removeAttribute('data-image-file');
    variantDiv.removeAttribute('data-image-blob');
    
    // Clear hidden fields
    const imageUrlInput = variantDiv.querySelector('.variant-image-url');
    const imagePublicIdInput = variantDiv.querySelector('.variant-image-public-id');
    if (imageUrlInput) imageUrlInput.value = '';
    if (imagePublicIdInput) imagePublicIdInput.value = '';
  }
}

function removeProductImage() {
  const preview = document.getElementById('productImagePreview');
  const upload = document.getElementById('productImageUpload');
  const input = document.getElementById('productImageInput');
  const previewImg = document.getElementById('productImagePreviewImg');
  
  // Reset to default Midwest logo
  previewImg.src = '../assets/images/Midwest.jpg';
  previewImg.alt = 'Midwest Grocery';
  
  preview.classList.remove('hidden');
  upload.classList.add('hidden');
  input.value = '';
}

function resetProductImage() {
  removeProductImage();
}

// Make image container clickable
document.addEventListener('DOMContentLoaded', function() {
  const imageContainer = document.getElementById('productImageContainer');
  const imageInput = document.getElementById('productImageInput');
  
  if (imageContainer && imageInput) {
    imageContainer.addEventListener('click', function() {
      imageInput.click();
    });
  }
});

// --------------------------- DATE FORMATTING ---------------------------
// Helper function to format date as "January 1, 2025       Saturday       HH:MM:SS AM/PM"
function formatDateWithDay(date) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  
  // Convert to Manila timezone (Asia/Manila, UTC+8)
  const dateObj = new Date(date);
  
  // Use Intl.DateTimeFormat to get proper timezone conversion
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    weekday: 'long'
  });
  
  const parts = formatter.formatToParts(dateObj);
  const year = parts.find(p => p.type === 'year').value;
  const monthNum = parseInt(parts.find(p => p.type === 'month').value) - 1;
  const day = parts.find(p => p.type === 'day').value;
  const dayOfWeek = parts.find(p => p.type === 'weekday').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const second = parts.find(p => p.type === 'second').value;
  const dayPeriod = parts.find(p => p.type === 'dayPeriod').value.toUpperCase();
  
  const month = months[monthNum];
  const time = `${String(hour).padStart(2, '0')}:${minute}:${second} ${dayPeriod}`;
  
  return `${month} ${day}, ${year}       ${dayOfWeek}       ${time}`;
}

// Cache bust: 2025-01-19 - Fixed timezone issue
function formatOrderDate(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return 'Invalid Date';
    }
    
    // Use local time methods to display date in user's timezone
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    return `${month}/${day}/${year}`;
  } catch (error) {
    console.error('Error formatting date:', dateString, error);
    return 'Invalid Date';
  }
}

// --------------------------- ORDERS ---------------------------
function renderOrders() {
  if (!ordersDT) {
    ordersDT = $('#ordersTable').DataTable({
      paging: true,
      searching: true,
      info: true,
      dom: 'ltip',
      order: [], // Disable default sorting - we'll pre-sort the data
      columns: [
        { title: 'Order ID' },
        { title: 'Customer' },
        { title: 'Contact' },
        { title: 'Address' },
        { title: 'Total' },
        { title: 'Discount' },
        { title: 'Net Total' },
        { title: 'Payment' },
        { title: 'Date' },
        { title: 'Status' },
        { title: 'Actions', orderable: false }
      ]
    });
    
    // Wire custom search input & move length
    const oSearch = document.getElementById('ordersSearch');
    if (oSearch) oSearch.addEventListener('input', () => ordersDT.search(oSearch.value).draw());
    const oWrapper = document.getElementById('ordersControlsLength');
    const oLengthNode = document.querySelector('#ordersTable_wrapper .dataTables_length');
    if (oWrapper && oLengthNode) oWrapper.appendChild(oLengthNode);
  }
  ordersDT.clear();
  // Apply date filter if present
  const matchesDate = (iso) => {
    if (!activeDateFilter) return true;
    if (!iso) return false;
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}` === activeDateFilter;
  };
  const totalCount = orders.length;
  const pendingCount = orders.filter(o => (o.status || 'Pending').toLowerCase() === 'pending').length;
  const processingCount = orders.filter(o => (o.status || '').toLowerCase() === 'processing').length;
  const completedCount = orders.filter(o => (o.status || '').toLowerCase() === 'completed').length;
  const cancelledCount = orders.filter(o => (o.status || '').toLowerCase() === 'cancelled').length;
  const totalEl = document.getElementById('ordersTotalCount');
  const pendingEl = document.getElementById('ordersPendingCount');
  const processingEl = document.getElementById('ordersProcessingCount');
  const completedEl = document.getElementById('ordersCompletedCount');
  const cancelledEl = document.getElementById('ordersCancelledCount');
  const navTotalEl = document.getElementById('ordersNavTotal');
  const navPendingEl = document.getElementById('ordersNavPending');
  const navProcessingEl = document.getElementById('ordersNavProcessing');
  const navCompletedEl = document.getElementById('ordersNavCompleted');
  const navCancelledEl = document.getElementById('ordersNavCancelled');
  if (totalEl) totalEl.textContent = totalCount;
  if (pendingEl) pendingEl.textContent = pendingCount;
  if (processingEl) processingEl.textContent = processingCount;
  if (completedEl) completedEl.textContent = completedCount;
  if (cancelledEl) cancelledEl.textContent = cancelledCount;
  if (navTotalEl) navTotalEl.textContent = totalCount;
  if (navPendingEl) navPendingEl.textContent = pendingCount;
  if (navProcessingEl) navProcessingEl.textContent = processingCount;
  if (navCompletedEl) navCompletedEl.textContent = completedCount;
  if (navCancelledEl) navCancelledEl.textContent = cancelledCount;

  // Prioritize orders: pending and processing first, then others
  const filteredOrders = orders.filter(o => matchesDate(o.createdAt));
  console.log('Total orders before prioritization:', filteredOrders.length);
  console.log('Order statuses:', filteredOrders.map(o => o.status));
  
  const prioritizedOrders = filteredOrders.sort((a, b) => {
    const statusA = (a.status || '').toLowerCase();
    const statusB = (b.status || '').toLowerCase();
    
    // Priority order: pending > processing > completed > cancelled
    const priorityOrder = { 'pending': 0, 'processing': 1, 'completed': 2, 'cancelled': 3 };
    const priorityA = priorityOrder[statusA] !== undefined ? priorityOrder[statusA] : 4;
    const priorityB = priorityOrder[statusB] !== undefined ? priorityOrder[statusB] : 4;
    
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    // If same priority, sort by date (newest first)
    const dateA = new Date(a.createdAt || 0);
    const dateB = new Date(b.createdAt || 0);
    return dateB - dateA;
  });
  

  prioritizedOrders.forEach((o, i) => {
    const paymentProofIndicator = o.payment === 'GCash' && o.payment_proof_image_url 
      ? '<span class="ml-2 text-green-600" title="Payment proof uploaded">✓</span>' 
      : '';
    const paymentCell = `${o.payment}${paymentProofIndicator}${o.payment === 'GCash' && o.ref ? `<div class="text-xs text-blue-600">Ref: ${o.ref}</div>` : ''}`;
    const status = (o.status || '').toLowerCase();
    const itemsHtml = Array.isArray(o.items) && o.items.length
      ? `<div class="text-xs text-gray-600 mt-1">${o.items.map(it => `${it.name || ('#'+it.product_id)} × ${it.quantity}`).join(', ')}</div>`
      : '';
    let actionsHtml = '';
    
    // Add visual priority indicators
    let statusClass = '';
    let statusIcon = '';
    if (status === 'pending') {
      statusClass = 'bg-yellow-100 text-yellow-800 font-semibold';
      statusIcon = '<i class="bi bi-hourglass-split"></i>';
    } else if (status === 'processing') {
      statusClass = 'bg-blue-100 text-blue-800 font-semibold';
      statusIcon = '<i class="bi bi-arrow-repeat"></i>';
    } else if (status === 'completed') {
      statusClass = 'bg-green-100 text-green-800';
      statusIcon = '<i class="bi bi-check-circle"></i>';
    } else if (status === 'cancelled') {
      statusClass = 'bg-red-100 text-red-800';
      statusIcon = '<i class="bi bi-x-circle"></i>';
    }
    
    if (status === 'completed') {
      actionsHtml = `<button onclick="showReceipt(orders[${i}])" class="text-green-600">Receipt</button>`;
    } else if (status === 'processing') {
      actionsHtml = `<button onclick="completeOrder(${i})" class="text-green-600">Complete</button>
                     <button onclick="showReceipt(orders[${i}])" class="text-blue-600 ml-2">Receipt</button>`;
    } else if (status === 'cancelled') {
      // Cancelled orders - no checking required, just show receipt
      actionsHtml = `<button onclick="showReceipt(orders[${i}])" class="text-gray-600">Receipt</button>
                     <span class="text-red-600 text-sm ml-2">Cancelled</span>`;
    } else {
      // Pending or other statuses
      actionsHtml = `<button onclick="openOrderReviewModal(${i})" class="text-blue-600">Check</button>
                     <button onclick="showReceipt(orders[${i}])" class="text-green-600 ml-2">Receipt</button>`;
    }
    
    ordersDT.row.add([
      o.displayId || o.id,
      `${o.customer}${itemsHtml}`,
      o.contact || '-',
      o.address || '-',
      `₱${o.total.toFixed(2)}`,
      `₱${o.discount.toFixed(2)}`,
      `₱${o.netTotal.toFixed(2)}`,
      paymentCell,
      (o.createdAt ? formatOrderDate(o.createdAt) : (o.date ? formatOrderDate(o.date) : (o.created_at ? formatOrderDate(o.created_at) : new Date().toLocaleDateString()))),
      `<span class="px-2 py-1 rounded text-xs ${statusClass} flex items-center gap-1">${statusIcon} ${o.status || '-'}</span>`,
      actionsHtml
    ]);
  });
  // Force DataTable to redraw with our prioritized data
  ordersDT.draw(false);
  
  // Ensure the table shows our prioritized order by disabling DataTable's internal sorting
  ordersDT.order([]).draw();
  
}

// Function to add test orders for demonstration
function addTestOrders() {
  const testOrders = [
    {
      id: 'TEST001',
      displayId: 'TEST001',
      customer: 'Test Pending Customer',
      contact: '09123456789',
      address: 'Test Address',
      total: 100.00,
      discount: 0.00,
      netTotal: 100.00,
      status: 'Pending',
      type: 'Online',
      payment: 'Cash',
      ref: '',
      items: [{ name: 'Test Product', quantity: 1, unit_price: 100.00, total_price: 100.00 }],
      createdAt: new Date().toISOString(),
      created_at: new Date().toISOString()
    },
    {
      id: 'TEST002',
      displayId: 'TEST002',
      customer: 'Test Processing Customer',
      contact: '09123456788',
      address: 'Test Address 2',
      total: 150.00,
      discount: 10.00,
      netTotal: 140.00,
      status: 'Processing',
      type: 'Online',
      payment: 'GCash',
      ref: 'GCASH123456',
      items: [{ name: 'Test Product 2', quantity: 2, unit_price: 75.00, total_price: 150.00 }],
      createdAt: new Date().toISOString(),
      created_at: new Date().toISOString()
    }
  ];
  
  // Add test orders to the beginning of the orders array
  orders.unshift(...testOrders);
  localStorage.setItem('orders', JSON.stringify(orders));
  
  // Refresh the orders display
  renderOrders();
  updateDashboard();
  
  console.log('Test orders added:', testOrders);
}

function openAddOrderModal() {
  console.log('openAddOrderModal called');
  editOrderIndex = null;
  orderItems = []; // Reset order items
  document.getElementById('orderModalTitle').innerText = "Add Order";
  document.getElementById('orderCustomer').value = '';
  document.getElementById('orderContact').value = '';
  document.getElementById('orderAddress').value = '';
  document.getElementById('orderTotal').value = '';
  document.getElementById('orderDiscount').value = '';
  document.getElementById('orderStatus').value = 'Pending';
  document.getElementById('orderType').value = 'Online';
  document.getElementById('orderPayment').value = 'Cash';
  document.getElementById('orderRef').value = '';
  document.getElementById('orderRef').classList.add('hidden');
  
  // Reset order items display
  updateOrderItemsDisplay();
  
  const modal = document.getElementById('orderModal');
  console.log('Order modal element:', modal);
  if (modal) {
    modal.classList.remove('hidden');
    console.log('Order modal should be visible now');
  } else {
    console.error('Order modal element not found');
  }
}

function editOrder(i) {
  editOrderIndex = i;
  const o = orders[i];
  document.getElementById('orderModalTitle').innerText = "Edit Order";
  document.getElementById('orderCustomer').value = o.customer;
  document.getElementById('orderContact').value = o.contact || '';
  document.getElementById('orderAddress').value = o.address || '';
  document.getElementById('orderTotal').value = o.total;
  document.getElementById('orderDiscount').value = o.discount;
  document.getElementById('orderStatus').value = o.status;
  document.getElementById('orderType').value = o.type || 'Online';
  document.getElementById('orderPayment').value = o.payment || 'Cash';
  document.getElementById('orderRef').value = o.ref || '';
  
  // Load existing items
  orderItems = (o.items || []).map((item, index) => ({
    id: Date.now() + index, // Generate new IDs for editing
    product_name: item.product_name || item.name || 'Unknown Product',
    quantity: item.quantity || 0,
    unit_price: item.unit_price || item.price || 0,
    total_price: item.total_price || (item.quantity * item.unit_price) || 0
  }));
  
  updateOrderItemsDisplay();
  toggleRefInput();
  document.getElementById('orderModal').classList.remove('hidden');
}

let reviewingOrderIndex = null;

function openOrderReviewModal(i) {
  reviewingOrderIndex = i;
  const o = orders[i];
  if (!o) return;
  document.getElementById('reviewOrderId').textContent = o.displayId || o.id;
  document.getElementById('reviewCustomer').textContent = o.customer;
  document.getElementById('reviewStatus').textContent = o.status || '-';
  document.getElementById('reviewPayment').textContent = o.payment || '-';
  document.getElementById('reviewRef').textContent = o.ref || '-';
  document.getElementById('reviewTotal').textContent = o.total.toFixed(2);
  document.getElementById('reviewDiscount').textContent = o.discount.toFixed(2);
  document.getElementById('reviewNetTotal').textContent = o.netTotal.toFixed(2);
  
  // Show payment proof if available
  const paymentProofSection = document.getElementById('reviewPaymentProofSection');
  const noPaymentProof = document.getElementById('reviewNoPaymentProof');
  const paymentProofImg = document.getElementById('reviewPaymentProofImg');
  if (o.payment === 'GCash' && o.payment_proof_image_url) {
    paymentProofSection.classList.remove('hidden');
    if (noPaymentProof) noPaymentProof.classList.add('hidden');
    paymentProofImg.src = o.payment_proof_image_url;
    paymentProofImg.onclick = () => window.open(o.payment_proof_image_url, '_blank');
  } else {
    paymentProofSection.classList.add('hidden');
    if (noPaymentProof) noPaymentProof.classList.remove('hidden');
  }
  // Fetch fresh order details with items (fallback to existing data)
  (async () => {
    try {
      // Prefer dedicated items endpoint; fall back to order.details items
      let items = [];
      try {
        const itemsRes = await apiFetch(`/orders/${o.id}/items`);
        items = itemsRes.items || [];
      } catch (_eItemsAuth) {
        try {
          const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/${o.id}/items/public`);
          if (r.ok) {
            const j = await r.json();
            items = j.items || [];
          }
        } catch (_) {}
      }
      if (!items.length) {
        let res;
        try {
          res = await apiFetch(`/orders/${o.id}`);
        } catch (_eAuth) {
          const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/${o.id}/public`);
          if (r.ok) res = await r.json();
        }
        const ord = (res && res.order) ? res.order : o;
        items = ord.items || [];
      }
      const rows = items.map(it => {
        // Handle different product name sources
        let baseName = it.product_name || 
                    it.name || 
                    (it.product_id && it.product_id.name) || 
                    (it.product_details && it.product_details.name) ||
                    'Unknown Product';
        
        // Extract variant name - prefer variant_name field, but also check if it's embedded in product_name
        let variantName = it.variant_name || null;
        
        // If variant_name is not set but product_name contains variant info (old format), extract it
        if (!variantName && baseName.includes(' (')) {
          const match = baseName.match(/^(.+?)\s*\((.+?)\)$/);
          if (match) {
            baseName = match[1].trim();
            variantName = match[2].trim();
          }
        }
        
        const displayName = variantName ? `${baseName} (${variantName})` : baseName;
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || (it.product_id && it.product_id.price) || it.price || 0);
        const total = Number(it.total_price || (qty * price));
        return `<tr>
          <td class="px-3 py-2">
            <div class="flex flex-col">
              <span>${displayName}</span>
              ${variantName ? `<span class="inline-block mt-1 px-2 py-0.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded">${variantName}</span>` : ''}
            </div>
          </td>
          <td class="px-3 py-2 text-right">${qty}</td>
          <td class="px-3 py-2 text-right">₱${price.toFixed(2)}</td>
          <td class="px-3 py-2 text-right">₱${total.toFixed(2)}</td>
        </tr>`;
      }).join('');
      document.getElementById('reviewItems').innerHTML = rows || '<tr><td class="px-3 py-2" colspan="4">No items</td></tr>';
    } catch (_e) {
      const rows = (o.items || []).map(it => {
        // Handle different product name sources
        let baseName = it.product_name || 
                    it.name || 
                    (it.product_id && it.product_id.name) || 
                    (it.product_details && it.product_details.name) ||
                    'Unknown Product';
        
        // Extract variant name - prefer variant_name field, but also check if it's embedded in product_name
        let variantName = it.variant_name || null;
        
        // If variant_name is not set but product_name contains variant info (old format), extract it
        if (!variantName && baseName.includes(' (')) {
          const match = baseName.match(/^(.+?)\s*\((.+?)\)$/);
          if (match) {
            baseName = match[1].trim();
            variantName = match[2].trim();
          }
        }
        
        const displayName = variantName ? `${baseName} (${variantName})` : baseName;
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || (it.product_id && it.product_id.price) || it.price || 0);
        const total = Number(it.total_price || (qty * price));
        return `<tr>
          <td class="px-3 py-2">
            <div class="flex flex-col">
              <span>${displayName}</span>
              ${variantName ? `<span class="inline-block mt-1 px-2 py-0.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded">${variantName}</span>` : ''}
            </div>
          </td>
          <td class="px-3 py-2 text-right">${qty}</td>
          <td class="px-3 py-2 text-right">₱${price.toFixed(2)}</td>
          <td class="px-3 py-2 text-right">₱${total.toFixed(2)}</td>
        </tr>`;
      }).join('');
      const el = document.getElementById('reviewItems');
      if (el) el.innerHTML = rows || '<tr><td class="px-3 py-2" colspan="4">No items</td></tr>';
    }
  })();
  document.getElementById('orderReviewModal').classList.remove('hidden');
}

function closeOrderReviewModal() {
  document.getElementById('orderReviewModal').classList.add('hidden');
  reviewingOrderIndex = null;
}

function openPaymentProofModal() {
  const img = document.getElementById('reviewPaymentProofImg');
  if (img && img.src) {
    const modalImg = document.getElementById('paymentProofModalImg');
    if (modalImg) {
      modalImg.src = img.src;
      document.getElementById('paymentProofModal').classList.remove('hidden');
    }
  }
}

function closePaymentProofModal() {
  document.getElementById('paymentProofModal').classList.add('hidden');
}

async function approveOrderFromModal() {
  if (reviewingOrderIndex === null) return;
  const o = orders[reviewingOrderIndex];
  try {
    const { isConfirmed } = await Swal.fire({
      icon: 'question',
      title: 'Approve order?',
      text: `Approve ${o.displayId || o.id} to Processing`,
      showCancelButton: true,
      confirmButtonText: 'Approve'
    });
    if (!isConfirmed) return;
    await apiFetch(`/orders/${o.id}/payment`, { method: 'PATCH', body: JSON.stringify({ status: 'Processing' }) });
    closeOrderReviewModal();
    await refreshOrdersOnly();
    await Swal.fire({ icon: 'success', title: 'Order approved', text: `Order ${o.displayId || o.id} is now Processing.` });
  } catch (_e) { Swal.fire({ icon: 'error', title: 'Approve failed' }); }
}

async function declineOrderFromModal() {
  if (reviewingOrderIndex === null) return;
  const o = orders[reviewingOrderIndex];
  try {
    await apiFetch(`/orders/${o.id}/payment`, { method: 'PATCH', body: JSON.stringify({ status: 'Declined' }) });
    closeOrderReviewModal();
    await refreshOrdersOnly();
  } catch (_e) { Swal.fire({ icon: 'error', title: 'Decline failed' }); }
}

async function completeOrder(orderIndex) {
  const o = orders[orderIndex];
  try {
    const { isConfirmed } = await Swal.fire({
      icon: 'question',
      title: 'Complete order?',
      text: `Mark ${o.displayId || o.id} as Completed`,
      showCancelButton: true,
      confirmButtonText: 'Complete'
    });
    if (!isConfirmed) return;
    await apiFetch(`/orders/${o.id}/payment`, { method: 'PATCH', body: JSON.stringify({ status: 'Completed' }) });
    await refreshOrdersOnly();
    await Swal.fire({ icon: 'success', title: 'Order completed', text: `Order ${o.displayId || o.id} is now Completed.` });
  } catch (_e) { Swal.fire({ icon: 'error', title: 'Complete order failed' }); }
}

async function saveOrder() {
  const customer = document.getElementById('orderCustomer').value.trim();
  const contact = document.getElementById('orderContact').value.trim();
  const address = document.getElementById('orderAddress').value.trim();
  const total = parseFloat(document.getElementById('orderTotal').value) || 0;
  const discountInput = document.getElementById('orderDiscount').value.trim();
  const status = document.getElementById('orderStatus').value;
  const type = document.getElementById('orderType').value;
  const payment = document.getElementById('orderPayment').value;
  const ref = document.getElementById('orderRef').value;

  // Compute discount
  let discount = 0;
  if (discountInput.includes('%')) {
    const percent = parseFloat(discountInput.replace('%', '')) || 0;
    discount = (percent / 100) * total;
  } else {
    discount = parseFloat(discountInput) || 0;
  }
  const netTotal = total - discount;

  if (!customer) { Swal.fire({ icon: 'warning', title: 'Customer name required' }); return; }

  // Upload payment proof if available
  let paymentProofImageUrl = null;
  let paymentProofPublicId = null;
  
  if (payment === 'GCash' && paymentProofFile) {
    try {
      const formData = new FormData();
      formData.append('image', paymentProofFile);
      
      // For new orders, we'll upload after order creation
      // For now, we'll store the file reference
    } catch (error) {
      console.error('Error preparing payment proof:', error);
    }
  }

  const newOrder = {
    id: 'ORD' + (orders.length + 1),
    customer,
    contact,
    address,
    total,
    discount,
    netTotal,
    status,
    type,
    payment,
    ref,
    payment_proof_image_url: paymentProofImageUrl,
    payment_proof_public_id: paymentProofPublicId,
    items: orderItems.map(item => ({
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price
    })),
    createdAt: new Date().toISOString()
  };

  if (editOrderIndex !== null) {
    // keep same id
    newOrder.id = orders[editOrderIndex].id;
    orders[editOrderIndex] = newOrder;
  } else {
    orders.push(newOrder);
  }

  localStorage.setItem('orders', JSON.stringify(orders));
  await saveToBackend();
  
  // Upload payment proof after order is created (if it's a new order and has payment proof)
  if (editOrderIndex === null && payment === 'GCash' && paymentProofFile) {
    try {
      const orderId = newOrder.id;
      const formData = new FormData();
      formData.append('image', paymentProofFile);
      
      const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/${orderId}/payment-proof/public`, {
        method: 'POST',
        body: formData
      });
      
      if (response.ok) {
        const result = await response.json();
        newOrder.payment_proof_image_url = result.order.payment_proof_image_url;
        newOrder.payment_proof_public_id = result.order.payment_proof_public_id;
        // Update in localStorage
        if (editOrderIndex !== null) {
          orders[editOrderIndex] = newOrder;
        } else {
          orders[orders.length - 1] = newOrder;
        }
        localStorage.setItem('orders', JSON.stringify(orders));
      }
    } catch (error) {
      console.error('Error uploading payment proof:', error);
      // Don't block order creation if payment proof upload fails
    }
  }
  
  closeOrderModal();
  renderOrders();
  updateDashboard();
  showReceipt(newOrder);
}

function deleteOrder(i) {
  if (!confirm('Delete this order?')) return;
  orders.splice(i, 1);
  localStorage.setItem('orders', JSON.stringify(orders));
  saveToBackend();
  renderOrders();
  updateDashboard();
}

function closeOrderModal() {
  // Reset payment proof
  removePaymentProof();
  console.log('closeOrderModal called');
  orderItems = []; // Reset order items when closing modal
  const modal = document.getElementById('orderModal');
  if (modal) {
    modal.classList.add('hidden');
    console.log('Order modal should be hidden now');
  } else {
    console.error('Order modal element not found');
  }
}

// Order Items Management Functions
function addOrderItem() {
  // Open product selection modal instead of using prompts
  openProductSelectionModal();
}

// Product Selection Modal Functions
let allProducts = [];
let filteredProducts = [];
let selectedProduct = null;

async function openProductSelectionModal() {
  const modal = document.getElementById('productSelectionModal');
  const loading = document.getElementById('productsLoading');
  const productsList = document.getElementById('productsList');
  const noProductsMessage = document.getElementById('noProductsMessage');
  const searchInput = document.getElementById('productSearchInput');
  
  modal.classList.remove('hidden');
  loading.classList.remove('hidden');
  productsList.innerHTML = '';
  noProductsMessage.classList.add('hidden');
  searchInput.value = '';
  
  try {
    // Load all products
    allProducts = await fetchAllProducts();
    filteredProducts = [...allProducts];
    
    loading.classList.add('hidden');
    renderProductsList();
  } catch (error) {
    console.error('Failed to load products:', error);
    loading.classList.add('hidden');
    noProductsMessage.classList.remove('hidden');
    noProductsMessage.textContent = 'Failed to load products';
  }
}

function closeProductSelectionModal() {
  const modal = document.getElementById('productSelectionModal');
  modal.classList.add('hidden');
  allProducts = [];
  filteredProducts = [];
}

function filterProducts() {
  const searchTerm = document.getElementById('productSearchInput').value.toLowerCase();
  filteredProducts = allProducts.filter(product => 
    product.name.toLowerCase().includes(searchTerm) ||
    (product.category && product.category.toLowerCase().includes(searchTerm)) ||
    (product.description && product.description.toLowerCase().includes(searchTerm))
  );
  renderProductsList();
}

function renderProductsList() {
  const productsList = document.getElementById('productsList');
  const noProductsMessage = document.getElementById('noProductsMessage');
  
  if (filteredProducts.length === 0) {
    productsList.innerHTML = '';
    noProductsMessage.classList.remove('hidden');
    return;
  }
  
  noProductsMessage.classList.add('hidden');
  productsList.innerHTML = filteredProducts.map(product => `
    <div class="flex items-center justify-between bg-gray-50 p-3 rounded border hover:bg-gray-100 cursor-pointer" 
         onclick="selectProduct(${product.id})">
      <div class="flex-1">
        <div class="font-medium">${product.name}</div>
        <div class="text-sm text-gray-600">
          ${product.category ? `Category: ${product.category}` : ''}
          ${product.stock !== undefined ? ` • Stock: ${product.stock}` : ''}
        </div>
        ${product.description ? `<div class="text-xs text-gray-500 mt-1">${product.description}</div>` : ''}
      </div>
      <div class="text-right">
        <div class="font-semibold text-green-600">₱${Number(product.price || 0).toFixed(2)}</div>
        <button class="mt-1 bg-green-600 text-white px-3 py-1 rounded text-sm hover:bg-green-700">
          Select
        </button>
      </div>
    </div>
  `).join('');
}

function selectProduct(productId) {
  const product = allProducts.find(p => p.id === productId);
  if (!product) return;
  
  // Store selected product and open quantity input modal
  selectedProduct = product;
  openQuantityInputModal();
  
  // Close the product selection modal
  closeProductSelectionModal();
}

// Quantity Input Modal Functions
function openQuantityInputModal() {
  if (!selectedProduct) return;
  
  const modal = document.getElementById('quantityInputModal');
  const productName = document.getElementById('quantityProductName');
  const unitPrice = document.getElementById('quantityUnitPrice');
  const quantityInput = document.getElementById('quantityInput');
  
  productName.textContent = selectedProduct.name;
  unitPrice.textContent = Number(selectedProduct.price || 0).toFixed(2);
  quantityInput.value = '1';
  
  // Update total price when quantity changes
  quantityInput.oninput = updateQuantityTotal;
  updateQuantityTotal();
  
  modal.classList.remove('hidden');
  quantityInput.focus();
  quantityInput.select();
}

function closeQuantityInputModal() {
  const modal = document.getElementById('quantityInputModal');
  modal.classList.add('hidden');
  selectedProduct = null;
}

function updateQuantityTotal() {
  const quantityInput = document.getElementById('quantityInput');
  const unitPrice = document.getElementById('quantityUnitPrice');
  const totalPrice = document.getElementById('quantityTotalPrice');
  
  const quantity = parseInt(quantityInput.value) || 0;
  const unitPriceValue = parseFloat(unitPrice.textContent) || 0;
  const total = quantity * unitPriceValue;
  
  totalPrice.textContent = total.toFixed(2);
}

function confirmQuantity() {
  if (!selectedProduct) return;
  
  const quantityInput = document.getElementById('quantityInput');
  const quantity = parseInt(quantityInput.value);
  
  if (!quantity || quantity <= 0) {
    Swal.fire({ icon: 'warning', title: 'Invalid quantity', text: 'Please enter a valid quantity greater than 0.' });
    return;
  }
  
  const item = {
    id: Date.now(), // Simple ID for tracking
    product_name: selectedProduct.name,
    quantity: quantity,
    unit_price: parseFloat(selectedProduct.price || 0),
    total_price: quantity * parseFloat(selectedProduct.price || 0)
  };
  
  orderItems.push(item);
  updateOrderItemsDisplay();
  updateOrderTotal();
  
  // Close the quantity input modal
  closeQuantityInputModal();
  
  // Show success message
  Swal.fire({ 
    icon: 'success', 
    title: 'Item Added', 
    text: `${selectedProduct.name} (${quantity}x) added to order`,
    timer: 2000,
    showConfirmButton: false
  });
}

function removeOrderItem(itemId) {
  orderItems = orderItems.filter(item => item.id !== itemId);
  updateOrderItemsDisplay();
  updateOrderTotal();
}

function updateOrderItemsDisplay() {
  const itemsList = document.getElementById('orderItemsList');
  const noItemsMessage = document.getElementById('noItemsMessage');
  
  if (orderItems.length === 0) {
    itemsList.innerHTML = '';
    noItemsMessage.classList.remove('hidden');
  } else {
    noItemsMessage.classList.add('hidden');
    itemsList.innerHTML = orderItems.map(item => `
      <div class="flex items-center justify-between bg-gray-50 p-3 rounded border">
        <div class="flex-1">
          <div class="font-medium">${item.product_name}</div>
          <div class="text-sm text-gray-600">
            Qty: ${item.quantity} × ₱${item.unit_price.toFixed(2)} = ₱${item.total_price.toFixed(2)}
          </div>
        </div>
        <button onclick="removeOrderItem(${item.id})" class="text-red-600 hover:text-red-800 ml-2">
          ✕
        </button>
      </div>
    `).join('');
  }
}

function updateOrderTotal() {
  const total = orderItems.reduce((sum, item) => sum + item.total_price, 0);
  const totalInput = document.getElementById('orderTotal');
  if (totalInput) {
    totalInput.value = total.toFixed(2);
  }
}

function toggleRefInput() {
  const payment = document.getElementById('orderPayment').value;
  const refInput = document.getElementById('orderRef');
  const paymentProofSection = document.getElementById('paymentProofSection');
  
  if (payment === 'GCash') {
    refInput.classList.remove('hidden');
    paymentProofSection.classList.remove('hidden');
  } else {
    refInput.classList.add('hidden');
    refInput.value = '';
    paymentProofSection.classList.add('hidden');
    // Clear payment proof if switching away from GCash
    removePaymentProof();
  }
}

// Payment proof image handling
let paymentProofImageUrl = null;
let paymentProofPublicId = null;

function handlePaymentProofSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  // Validate file type
  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    Swal.fire({ icon: 'error', title: 'Invalid file type', text: 'Please upload a JPG, PNG, GIF, or WebP image' });
    return;
  }
  
  // Validate file size (5MB)
  const maxSize = 5 * 1024 * 1024;
  if (file.size > maxSize) {
    Swal.fire({ icon: 'error', title: 'File too large', text: 'Maximum file size is 5MB' });
    return;
  }
  
  // Show preview
  const reader = new FileReader();
  reader.onload = function(e) {
    const preview = document.getElementById('paymentProofPreview');
    const previewImg = document.getElementById('paymentProofPreviewImg');
    const upload = document.getElementById('paymentProofUpload');
    
    previewImg.src = e.target.result;
    preview.classList.remove('hidden');
    upload.classList.add('hidden');
  };
  reader.readAsDataURL(file);
  
  // Store file for upload
  paymentProofFile = file;
}

function removePaymentProof() {
  const preview = document.getElementById('paymentProofPreview');
  const previewImg = document.getElementById('paymentProofPreviewImg');
  const upload = document.getElementById('paymentProofUpload');
  const input = document.getElementById('paymentProofInput');
  
  preview.classList.add('hidden');
  upload.classList.remove('hidden');
  previewImg.src = '';
  input.value = '';
  paymentProofImageUrl = null;
  paymentProofPublicId = null;
  paymentProofFile = null;
}

let paymentProofFile = null;

// Make payment proof upload area clickable
document.addEventListener('DOMContentLoaded', function() {
  const paymentProofUpload = document.getElementById('paymentProofUpload');
  const paymentProofInput = document.getElementById('paymentProofInput');
  
  if (paymentProofUpload && paymentProofInput) {
    paymentProofUpload.addEventListener('click', function() {
      paymentProofInput.click();
    });
  }
});

// --------------------------- LOW STOCK ITEMS ---------------------------
async function loadAllLowStockItems() {
  const grid = document.getElementById('lowStockGrid');
  const loading = document.getElementById('lowStockLoading');
  const summary = document.getElementById('lowStockSummary');
  const noItemsMessage = document.getElementById('noLowStockMessage');
  
  if (!grid || !loading) return;
  
  loading.classList.remove('hidden');
  grid.innerHTML = '';
  summary.classList.add('hidden');
  noItemsMessage.classList.add('hidden');

  const threshold = document.getElementById('lowStockThreshold')?.value || '5';

  try {
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/low-stock?threshold=${threshold}`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch low stock items');
    }
    
    const data = await response.json();
    const lowStockItems = data.products || [];
    
    if (lowStockItems.length === 0) {
      noItemsMessage.classList.remove('hidden');
    } else {
      renderLowStockItems(lowStockItems);
      updateLowStockSummary(data);
      summary.classList.remove('hidden');
    }
    
  } catch (error) {
    console.error('Failed to load low stock items:', error);
    grid.innerHTML = '<div class="col-span-full text-center text-red-500">Failed to load low stock items</div>';
  } finally {
    loading.classList.add('hidden');
  }
}

function renderLowStockItems(items) {
  const grid = document.getElementById('lowStockGrid');
  if (!grid) return;
  
  grid.innerHTML = '';
  
  items.forEach(item => {
    const itemCard = document.createElement('div');
    itemCard.className = `bg-white border rounded-lg p-4 shadow-sm ${
      item.stock === 0 ? 'border-red-200 bg-red-50' : 'border-yellow-200 bg-yellow-50'
    }`;
    
    const actualStock = Math.max(0, item.stock || 0); // Ensure stock is never negative
    const stockStatus = actualStock === 0 ? 'Out of Stock' : 'Low Stock';
    const stockColor = actualStock === 0 ? 'text-red-600' : 'text-yellow-600';
    
    // Create image with base64 support
    const imageHtml = item.has_image 
      ? `<img 
          src="${item.image_url}" 
          alt="${item.name}" 
          class="w-full h-32 object-cover rounded"
          onerror="this.src='../assets/images/Midwest.jpg'">`
      : `<img 
          src="../assets/images/Midwest.jpg" 
          alt="Midwest Grocery" 
          class="w-full h-32 object-cover rounded">`;
    
    itemCard.innerHTML = `
      ${imageHtml}
      <div class="mt-3">
        <h3 class="font-semibold text-gray-800">${item.name}</h3>
        <p class="text-sm text-gray-600">${item.category}</p>
        <p class="text-green-600 font-bold">₱${Number(item.price || 0).toFixed(2)}</p>
        <div class="flex justify-between items-center mt-2">
          <span class="text-sm ${stockColor} font-semibold">${stockStatus}</span>
          <span class="text-sm text-gray-500">Stock: ${actualStock}</span>
        </div>
        <div class="mt-3 flex gap-2">
          <button onclick="openRestockModalFromLowStock(${item.id})" 
                  class="bg-indigo-600 text-white px-3 py-1 rounded text-sm hover:bg-indigo-700">
            Restock
          </button>
          <button onclick="editProductFromLowStock(${item.id})" 
                  class="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700">
            Edit
          </button>
        </div>
      </div>
    `;
    
    grid.appendChild(itemCard);
  });

  // Initialize lazy loading for new images
  setTimeout(() => {
    lazyLoadImages();
    preloadCriticalImages();
  }, 100);
}

function updateLowStockSummary(data) {
  const totalEl = document.getElementById('totalLowStockCount');
  const outOfStockEl = document.getElementById('outOfStockCount');
  const lowStockEl = document.getElementById('lowStockCount');
  
  if (totalEl) totalEl.textContent = data.total || 0;
  if (outOfStockEl) outOfStockEl.textContent = data.out_of_stock || 0;
  if (lowStockEl) lowStockEl.textContent = data.low_stock || 0;
}

function openRestockModalFromLowStock(productId) {
  // Find the product in the current low stock items
  // Reuse server-side flow to fetch the product and open the restock modal
  openRestockModalFromTable(productId);
}

function editProductFromLowStock(productId) {
  // Navigate to inventory section and edit the product
  showSection('inventorySection');
  // You might want to implement a way to highlight the specific product
  Swal.fire({ icon: 'info', title: 'Edit Product', text: `Edit product ID: ${productId} in inventory section` });
}

function setupLowStockSearch() {
  const searchInput = document.getElementById('lowStockSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const items = document.querySelectorAll('#lowStockGrid > div');
      
      items.forEach(item => {
        const name = item.querySelector('h3')?.textContent.toLowerCase() || '';
        const category = item.querySelector('p')?.textContent.toLowerCase() || '';
        
        if (name.includes(searchTerm) || category.includes(searchTerm)) {
          item.style.display = 'block';
        } else {
          item.style.display = 'none';
        }
      });
    });
  }
}

// --------------------------- SUPPLIERS ---------------------------
function renderSuppliers() {
  if (!suppliersDT) {
    suppliersDT = $('#suppliersTable').DataTable({
      paging: true,
      searching: true,
      info: true,
      dom: 'ltip',
      order: [[0, 'asc']],
      columns: [
        { title: 'Supplier' },
        { title: 'Contact' },
        { title: 'Items Supplied' },
        { title: 'Last Delivery' },
        { title: 'Actions', orderable: false }
      ]
    });
    const sSearch = document.getElementById('suppliersSearch');
    if (sSearch) sSearch.addEventListener('input', () => suppliersDT.search(sSearch.value).draw());
    const sWrapper = document.getElementById('suppliersControlsLength');
    const sLengthNode = document.querySelector('#suppliersTable_wrapper .dataTables_length');
    if (sWrapper && sLengthNode) sWrapper.appendChild(sLengthNode);
  }
  suppliersDT.clear();
  const fmtDate = (val) => {
    if (!val) return '-';
    const d = new Date(val);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  suppliers.forEach((s, i) => {
    suppliersDT.row.add([
      s.name,
      s.contact,
      (s.items || []).join(', '),
      fmtDate(s.lastDelivery),
      `<button onclick="editSupplier(${i})" class="text-blue-600">Edit</button>
       <button onclick="deleteSupplier(${i})" class="text-red-600 ml-2">Delete</button>`
    ]);
  });
  suppliersDT.draw(false);
  populateRestockSuppliersSelect();
}

function openAddSupplierModal() {
  console.log('openAddSupplierModal called');
  editSupplierIndex = null;
  document.getElementById('supplierModalTitle').innerText = 'Add Supplier';
  document.getElementById('supplierName').value = '';
  document.getElementById('supplierContact').value = '';
  document.getElementById('supplierItems').value = '';
  document.getElementById('supplierLastDelivery').value = '';
  const modal = document.getElementById('supplierModal');
  console.log('Supplier modal element:', modal);
  if (modal) {
    modal.classList.remove('hidden');
    console.log('Supplier modal should be visible now');
  } else {
    console.error('Supplier modal element not found');
  }
}

// Export suppliers CSV
function exportSuppliersCSV() {
  try {
    fetch(`${window.APP_CONFIG.API_BASE_URL}/suppliers`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } })
      .then(r => r.json())
      .then(data => {
        const list = (data.suppliers || []);
        const rows = list.map(s => [ s.id, s.name, s.contact || '', (s.items||[]).join('; '), s.last_delivery || s.lastDelivery || '' ]);
        const header = ['ID','Supplier','Contact','Items','Last Delivery'];
        const csv = [header].concat(rows)
          .map(r => r.map(v => String(v).replace(/"/g,'""')).map(v=>`"${v}"`).join(','))
          .join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `suppliers-${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
  } catch (_) {}
}

// Export suppliers PDF
function exportSuppliersPDF() {
  try {
    fetch(`${window.APP_CONFIG.API_BASE_URL}/suppliers`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } })
      .then(r => r.json())
      .then(data => {
        const list = (data.suppliers || []);
        const rows = list.map(s => `<tr><td>${s.name}</td><td>${s.contact || ''}</td><td>${(s.items||[]).join('; ')}</td><td>${s.last_delivery || s.lastDelivery || ''}</td></tr>`).join('');
        const styles = `body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial} table{width:100%;border-collapse:collapse} th,td{border:1px solid #e5e7eb;padding:6px 8px;font-size:12px} th{background:#f3f4f6;text-align:left}`;
        const html = `<h2>Suppliers</h2><table><thead><tr><th>Supplier</th><th>Contact</th><th>Items</th><th>Last Delivery</th></tr></thead><tbody>${rows}</tbody></table>`;
        const w = window.open('', '', 'width=900,height=700');
        w.document.write(`<html><head><title>Suppliers</title><style>${styles}</style></head><body>${html}</body></html>`);
        w.document.close(); w.focus(); w.print();
      });
  } catch (_) {}
}

function editSupplier(i) {
  editSupplierIndex = i;
  const s = suppliers[i];
  document.getElementById('supplierModalTitle').innerText = 'Edit Supplier';
  document.getElementById('supplierName').value = s.name;
  document.getElementById('supplierContact').value = s.contact;
  document.getElementById('supplierItems').value = (s.items || []).join(', ');
  document.getElementById('supplierLastDelivery').value = s.lastDelivery || '';
  document.getElementById('supplierModal').classList.remove('hidden');
}

function saveSupplier() {
  const name = document.getElementById('supplierName').value.trim();
  const contact = document.getElementById('supplierContact').value.trim();
  const itemsRaw = document.getElementById('supplierItems').value.trim();
  const lastDelivery = document.getElementById('supplierLastDelivery').value || '';

  if (!name) { Swal.fire({ icon: 'warning', title: 'Supplier name required' }); return; }

  const items = itemsRaw ? itemsRaw.split(',').map(it => it.trim()).filter(Boolean) : [];

  const supplierObj = { name, contact, items, lastDelivery };

  if (editSupplierIndex !== null) {
    const existing = suppliers[editSupplierIndex] || {};
    const id = existing.id;
    suppliers[editSupplierIndex] = Object.assign({}, existing, supplierObj);
    localStorage.setItem('suppliers', JSON.stringify(suppliers));
    if (id) {
      apiFetch(`/suppliers/${id}`, { method: 'PATCH', body: JSON.stringify({ name, contact, lastDelivery }) })
        .then(res => {
          const updated = res.supplier || {};
          suppliers[editSupplierIndex] = Object.assign({}, suppliers[editSupplierIndex], {
            id: updated.id,
            name: updated.name,
            contact: updated.contact,
            lastDelivery: updated.last_delivery || updated.lastDelivery || ''
          });
          localStorage.setItem('suppliers', JSON.stringify(suppliers));
          renderSuppliers();
          updateDashboard();
        })
        .catch(() => { /* ignore for now */ });
    }
  } else {
    suppliers.push(supplierObj);
  }

  localStorage.setItem('suppliers', JSON.stringify(suppliers));
  closeSupplierModal();
  renderSuppliers();
}

function deleteSupplier(i) {
  if (!confirm('Delete this supplier?')) return;
  suppliers.splice(i, 1);
  localStorage.setItem('suppliers', JSON.stringify(suppliers));
  saveToBackend();
  renderSuppliers();
}

function closeSupplierModal() {
  console.log('closeSupplierModal called');
  const modal = document.getElementById('supplierModal');
  if (modal) {
    modal.classList.add('hidden');
    console.log('Supplier modal should be hidden now');
  } else {
    console.error('Supplier modal element not found');
  }
}

// --------------------------- RESTOCK FLOW ---------------------------
function openRestockModal(productIndex) {
  restockProductIndex = productIndex;
  const p = products[productIndex];
  
  // Update product name display
  const stockDisplay = p.variants && p.variants.length > 0
    ? `Total: ${Number(p.stock || 0)}`
    : `current: ${Number(p.stock || 0)}`;
  document.getElementById('restockProductName').textContent = `${p.name} (${stockDisplay})`;
  
  // Handle variants
  const variantSection = document.getElementById('restockVariantSection');
  const variantSelect = document.getElementById('restockVariant');
  const variantStockInfo = document.getElementById('restockVariantStock');
  
  if (p.variants && p.variants.length > 0) {
    // Show variant selection
    variantSection.classList.remove('hidden');
    variantSelect.innerHTML = '<option value="">-- Select Variant --</option>';
    
    p.variants.forEach(variant => {
      const option = document.createElement('option');
      option.value = variant._id || '';
      const variantName = variant.name || 'Unnamed Variant';
      option.textContent = `${variantName} (Stock: ${variant.stock || 0})`;
      option.setAttribute('data-stock', variant.stock || 0);
      variantSelect.appendChild(option);
    });
    
    // Update stock info when variant is selected (remove old listeners first)
    const newSelect = variantSelect.cloneNode(true);
    variantSelect.parentNode.replaceChild(newSelect, variantSelect);
    document.getElementById('restockVariant').addEventListener('change', function() {
      const selectedOption = this.options[this.selectedIndex];
      if (selectedOption.value) {
        const stock = selectedOption.getAttribute('data-stock') || 0;
        variantStockInfo.textContent = `Current stock: ${stock}`;
      } else {
        variantStockInfo.textContent = '';
      }
    });
  } else {
    // Hide variant selection for products without variants
    variantSection.classList.add('hidden');
    variantSelect.innerHTML = '<option value="">-- Select Variant --</option>';
    variantStockInfo.textContent = '';
  }
  
  document.getElementById('restockQty').value = '';
  document.getElementById('restockDate').value = new Date().toISOString().slice(0,10);
  populateRestockSuppliersSelect();
  document.getElementById('restockModal').classList.remove('hidden');
}

function populateRestockSuppliersSelect() {
  const sel = document.getElementById('restockSupplier');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select supplier --</option>';
  suppliers.forEach((s, i) => {
    sel.innerHTML += `<option value="${i}">${s.name}</option>`;
  });
}

function closeRestockModal() {
  document.getElementById('restockModal').classList.add('hidden');
  restockProductIndex = null;
  restockProductIdDirect = null;
  restockProductNameDirect = null;
  
  // Reset variant selection
  const variantSection = document.getElementById('restockVariantSection');
  const variantSelect = document.getElementById('restockVariant');
  const variantStockInfo = document.getElementById('restockVariantStock');
  if (variantSection) variantSection.classList.add('hidden');
  if (variantSelect) variantSelect.innerHTML = '<option value="">-- Select Variant --</option>';
  if (variantStockInfo) variantStockInfo.textContent = '';
}

function confirmRestock() {
  const supplierIndex = document.getElementById('restockSupplier').value;
  const qty = parseInt(document.getElementById('restockQty').value) || 0;
  const date = document.getElementById('restockDate').value || new Date().toISOString().slice(0,10);
  const variantId = document.getElementById('restockVariant').value || null;

  if (restockProductIndex === null && restockProductIdDirect === null) { Swal.fire({ icon: 'warning', title: 'Product not selected' }); return; }
  if (!qty || qty <= 0) { Swal.fire({ icon: 'warning', title: 'Enter a valid quantity' }); return; }
  if (supplierIndex === '') { Swal.fire({ icon: 'warning', title: 'Select a supplier' }); return; }
  
  // Check if variant is required
  const variantSection = document.getElementById('restockVariantSection');
  if (!variantSection.classList.contains('hidden') && !variantId) {
    Swal.fire({ icon: 'warning', title: 'Please select a variant' }); 
    return;
  }

  // update product stock (local cache only when using index flow)
  if (restockProductIndex !== null) {
    products[restockProductIndex].stock = (products[restockProductIndex].stock || 0) + qty;
    localStorage.setItem('products', JSON.stringify(products));
  }

  // update supplier lastDelivery and ensure product is in supplier.items
  suppliers[supplierIndex].lastDelivery = date;
  const prodName = restockProductIndex !== null ? products[restockProductIndex].name : (restockProductNameDirect || 'Product');
  suppliers[supplierIndex].items = suppliers[supplierIndex].items || [];
  if (!suppliers[supplierIndex].items.includes(prodName)) {
    suppliers[supplierIndex].items.push(prodName);
  }
  localStorage.setItem('suppliers', JSON.stringify(suppliers));
  
  // Persist restock in backend: update stock, last_delivery, and link
  try {
    const supplierId = suppliers[supplierIndex].id;
    const productId = restockProductIndex !== null ? products[restockProductIndex].id : restockProductIdDirect;
    if (supplierId && productId) {
      const restockData = { productId, qty, date };
      if (variantId) {
        restockData.variantId = variantId;
      }
      
      apiFetch(`/suppliers/${supplierId}/restock`, { method: 'POST', body: JSON.stringify(restockData) })
        .then(() => refreshInventoryOnly())
        .catch((error) => {
          console.error('Restock API error:', error);
          Swal.fire({ 
            icon: 'error', 
            title: 'Restock Failed', 
            text: error.message || 'Failed to save restock to server. Changes saved locally only.' 
          });
        });
    }
  } catch (error) {
    console.error('Restock error:', error);
    Swal.fire({ 
      icon: 'error', 
      title: 'Restock Error', 
      text: error.message || 'An error occurred while processing restock.' 
    });
  }

  closeRestockModal();
  renderInventory();
  renderSuppliers();
  updateDashboard();
  
  const variantName = variantId ? ` (${document.getElementById('restockVariant').options[document.getElementById('restockVariant').selectedIndex].textContent.split(' (')[0]})` : '';
  Swal.fire({ icon: 'success', title: 'Restocked', text: `${qty} × ${prodName}${variantName} from ${suppliers[supplierIndex].name}` });
}

// --------------------------- LOW STOCK ALERTS ---------------------------
function computeLowStock() {
  return products.filter(p => Number(p.stock || 0) < getLowStockThreshold(p));
}

async function toggleLowStockModal() {
  console.log('toggleLowStockModal called');
  const modal = document.getElementById('lowStockModal');
  console.log('Low stock modal element:', modal);
  if (modal) {
    if (modal.classList.contains('hidden')) {
      // open and populate
      await renderLowStockModalList(showAllLowStockInModal);
      modal.classList.remove('hidden');
      console.log('Low stock modal should be visible now');
    } else {
      modal.classList.add('hidden');
      console.log('Low stock modal should be hidden now');
    }
  } else {
    console.error('Low stock modal element not found');
  }
}

async function renderLowStockModalList(showAll) {
  const list = document.getElementById('lowStockModalList');
  
  try {
    // Use API data instead of local computation
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/low-stock?threshold=5`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      const low = data.products || [];
      
      if (!low.length) { 
        list.innerHTML = '<li>No low stock items</li>'; 
        return; 
      }
      
      const items = showAll ? low : low.slice(0, LOW_STOCK_MODAL_LIMIT);
      const extra = Math.max(low.length - items.length, 0);
      const itemsHtml = items.map(p => `<li>${p.name} — ${p.stock} left</li>`).join('');
      const controlHtml = extra > 0
        ? `<li class="mt-2"><button class="text-blue-600" onclick="showAllLowStockInModal=true;renderLowStockModalList(true)">Show all (${extra} more)</button></li>`
        : (showAll && low.length > LOW_STOCK_MODAL_LIMIT
            ? `<li class="mt-2"><button class="text-blue-600" onclick="showAllLowStockInModal=false;renderLowStockModalList(false)">Show less</button></li>`
            : '');
      list.innerHTML = itemsHtml + controlHtml;
    } else {
      // Fallback to local computation
      const low = computeLowStock();
      if (!low.length) { list.innerHTML = '<li>No low stock items</li>'; return; }
      const items = showAll ? low : low.slice(0, LOW_STOCK_MODAL_LIMIT);
      const extra = Math.max(low.length - items.length, 0);
      const itemsHtml = items.map(p => `<li>${p.name} — ${p.stock} left</li>`).join('');
      const controlHtml = extra > 0
        ? `<li class="mt-2"><button class="text-blue-600" onclick="showAllLowStockInModal=true;renderLowStockModalList(true)">Show all (${extra} more)</button></li>`
        : (showAll && low.length > LOW_STOCK_MODAL_LIMIT
            ? `<li class="mt-2"><button class="text-blue-600" onclick="showAllLowStockInModal=false;renderLowStockModalList(false)">Show less</button></li>`
            : '');
      list.innerHTML = itemsHtml + controlHtml;
    }
  } catch (error) {
    console.error('Failed to load low stock items for modal:', error);
    // Fallback to local computation
    const low = computeLowStock();
    if (!low.length) { list.innerHTML = '<li>No low stock items</li>'; return; }
    const items = showAll ? low : low.slice(0, LOW_STOCK_MODAL_LIMIT);
    const extra = Math.max(low.length - items.length, 0);
    const itemsHtml = items.map(p => `<li>${p.name} — ${p.stock} left</li>`).join('');
    const controlHtml = extra > 0
      ? `<li class="mt-2"><button class="text-blue-600" onclick="showAllLowStockInModal=true;renderLowStockModalList(true)">Show all (${extra} more)</button></li>`
      : (showAll && low.length > LOW_STOCK_MODAL_LIMIT
          ? `<li class="mt-2"><button class="text-blue-600" onclick="showAllLowStockInModal=false;renderLowStockModalList(false)">Show less</button></li>`
          : '');
    list.innerHTML = itemsHtml + controlHtml;
  }
}

// --------------------------- RECEIPT FUNCTIONS ---------------------------
function showReceipt(order) {
  document.getElementById('receiptId').textContent = order.id;
  try {
    const d = new Date();
    document.getElementById('receiptDateMeta').textContent = d.toLocaleString();
  } catch (_e) {}
  document.getElementById('receiptCustomer').textContent = order.customer;
  document.getElementById('receiptPayment').textContent = order.payment;
  document.getElementById('receiptRef').textContent = order.payment === 'GCash' && order.ref ? order.ref : '-';
  document.getElementById('receiptStatus').textContent = order.status;
  // Pre-fill using order object; will be reconciled after loading items
  document.getElementById('receiptTotal').textContent = Number(order.total || order.totalPrice || 0).toFixed(2);
  document.getElementById('receiptDiscount').textContent = Number(order.discount || 0).toFixed(2);
  document.getElementById('receiptNetTotal').textContent = Number(order.netTotal || order.net_total || (Number(order.total || order.totalPrice || 0) - Number(order.discount || 0))).toFixed(2);
  // Load items into receipt table
  (async () => {
    try {
      let items = [];
      // Prefer loading the full order with embedded items (more reliable)
      try {
        const full = await apiFetch(`/orders/${order.id}`);
        if (full && full.order && Array.isArray(full.order.items) && full.order.items.length) {
          items = full.order.items;
        }
      } catch (_e1) {}
      // Fallback to items endpoint
      if (!items.length) {
        try {
          const res = await apiFetch(`/orders/${order.id}/items`);
          items = res.items || [];
        } catch (_eAuth) {
          const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/${order.id}/items/public`);
          if (r.ok) {
            const j = await r.json();
            items = j.items || [];
          }
        }
      }
      // Final fallback: items carried on the order object
      if (!items.length && Array.isArray(order.items)) {
        items = order.items;
      }
      const rows = items.map(it => {
        // Handle different product name sources
        let baseName = it.product_name || 
                    it.name || 
                    (it.product_id && it.product_id.name) || 
                    (it.product_details && it.product_details.name) ||
                    'Unknown Product';
        
        // Extract variant name - prefer variant_name field, but also check if it's embedded in product_name
        let variantName = it.variant_name || null;
        
        // If variant_name is not set but product_name contains variant info (old format), extract it
        if (!variantName && baseName.includes(' (')) {
          const match = baseName.match(/^(.+?)\s*\((.+?)\)$/);
          if (match) {
            baseName = match[1].trim();
            variantName = match[2].trim();
          }
        }
        
        const displayName = variantName ? `${baseName} (${variantName})` : baseName;
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || it.price || 0);
        const total = Number(it.total_price || (qty * price));
        return `<tr>
          <td class="px-3 py-2">
            <div class="flex flex-col">
              <span>${displayName}</span>
              ${variantName ? `<span class="inline-block mt-1 px-2 py-0.5 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded">${variantName}</span>` : ''}
            </div>
          </td>
          <td class="px-3 py-2 text-right">${qty}</td>
          <td class="px-3 py-2 text-right">₱${price.toFixed(2)}</td>
          <td class="px-3 py-2 text-right">₱${total.toFixed(2)}</td>
        </tr>`;
      }).join('');
      document.getElementById('receiptItems').innerHTML = rows || '<tr><td class="px-3 py-2" colspan="4">No items</td></tr>';
      // Recompute totals from the loaded items (ensures accuracy)
      if (items.length) {
        const computedTotal = items.reduce((s, it) => s + Number(it.total_price || (Number(it.quantity||0) * Number(it.unit_price || it.price || 0))), 0);
        const discount = Number(order.discount || 0);
        const net = computedTotal - discount;
        document.getElementById('receiptTotal').textContent = computedTotal.toFixed(2);
        document.getElementById('receiptDiscount').textContent = discount.toFixed(2);
        document.getElementById('receiptNetTotal').textContent = net.toFixed(2);
      }
    } catch (_e) {
      document.getElementById('receiptItems').innerHTML = '<tr><td class="px-3 py-2" colspan="4">No items</td></tr>';
    }
  })();
  document.getElementById('receiptModal').classList.remove('hidden');
}

function closeReceipt() {
  document.getElementById('receiptModal').classList.add('hidden');
}

function printReceipt() {
  const receiptHtml = document.getElementById('receiptContent').innerHTML;
  const styles = `
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; color: #111827; }
    .rc-header { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
    .rc-brand { font-weight:700; font-size:18px; }
    .rc-meta { font-size:12px; color:#6b7280; }
    .rc-section { margin-top:12px; border-top:1px solid #e5e7eb; padding-top:12px; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:6px 8px; font-size:13px; }
    th { background:#f3f4f6; text-align:left; font-weight:600; }
    td.num, th.num { text-align:right; }
    .rc-total-row td { font-weight:600; }
    .no-print { display:none }
  `;
  const w = window.open('', '', 'width=620,height=800');
  w.document.write(`<html><head><title>Receipt</title><style>${styles}</style></head><body>${receiptHtml}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
}

// --------------------------- DASHBOARD & CHART ---------------------------
async function updateDashboard() {
  const today = new Date();
  const isSameDay = (d) => {
    if (!d) return false;
    const nd = new Date(d);
    return nd.getFullYear() === today.getFullYear() && nd.getMonth() === today.getMonth() && nd.getDate() === today.getDate();
  };
  const selectedOrders = (() => {
    if (!activeDateFilter) return orders.filter(o => isSameDay(o.createdAt));
    return orders.filter(o => {
      if (!o.createdAt) return false;
      const d = new Date(o.createdAt);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}` === activeDateFilter;
    });
  })();
  const totalSales = selectedOrders.reduce((sum, o) => sum + (o.netTotal || 0), 0);
  const totalOrders = selectedOrders.length;
  const customers = [...new Set(selectedOrders.map(o => o.customer))].length;
  
  // Fetch low stock items from API
  let lowStockItems = [];
  let lowStockCount = 0;
  
  try {
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/low-stock?threshold=5`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      lowStockItems = data.products || [];
      lowStockCount = data.total || 0;
      console.log('Low stock count from API:', lowStockCount);
    } else {
      // Fallback to local computation
      const lowStock = computeLowStock();
      lowStockItems = lowStock;
      lowStockCount = lowStock.length;
      console.log('Low stock count from local computation:', lowStockCount);
    }
  } catch (error) {
    console.error('Failed to fetch low stock items:', error);
    // Fallback to local computation
    const lowStock = computeLowStock();
    lowStockItems = lowStock;
    lowStockCount = lowStock.length;
  }

  document.getElementById('totalSales').textContent = `₱${totalSales.toFixed(2)}`;
  document.getElementById('totalOrders').textContent = totalOrders;
  document.getElementById('totalCustomers').textContent = customers;
  document.getElementById('lowStockCount').textContent = lowStockCount;

  // notification badge (cap to 99+ for layout)
  const notif = document.getElementById('notifCount');
  if (notif) notif.textContent = lowStockCount > 99 ? '99+' : String(lowStockCount);

  // low stock list on dashboard
  const lowStockList = document.getElementById('lowStockList');
  if (lowStockItems.length) {
    const limited = lowStockItems.slice(0, dashboardLowStockDisplayLimit);
    const extraCount = Math.max(lowStockItems.length - dashboardLowStockDisplayLimit, 0);
    const itemsHtml = limited.map(item => {
      const actualStock = Math.max(0, item.stock || 0); // Ensure stock is never negative
      const stockText = actualStock === 0 ? 'Out of Stock' : `${actualStock} left`;
      const stockColor = actualStock === 0 ? 'text-red-600' : 'text-yellow-600';
      const productId = item.id || item._id || '';
      return `<li class="flex justify-between items-center">
        <span>${item.name} <span class="${stockColor}">(${stockText})</span></span>
        <button class="text-indigo-600 ml-2" onclick="openRestockModalFromLowStock('${productId}')">Receive</button>
      </li>`;
    }).join('');
    const extraHtml = extraCount > 0 ? `<li class="mt-2 text-sm text-gray-600">and ${extraCount} more… <button class="text-blue-600" onclick="showMoreLowStockItems()">Show 5 more</button></li>` : '';
    lowStockList.innerHTML = itemsHtml + extraHtml;
  } else {
    lowStockList.innerHTML = '<li>No low stock items</li>';
  }

  // simple chart: weekly sample (placeholder)
  // try to load real data; fallback to placeholder if fails
  loadSalesOverview();
}

// Function to show 5 more low stock items in the dashboard
function showMoreLowStockItems() {
  dashboardLowStockDisplayLimit += 5;
  // Re-render the low stock list with the new limit
  updateDashboard();
}

// Chart.js setup
const ctx = document.getElementById('salesChart').getContext('2d');
const salesChart = new Chart(ctx, {
  type: 'bar',
  data: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [
      { label: 'Online Sales', backgroundColor: '#3b82f6', data: [] },
      { label: 'In-Store Sales', backgroundColor: '#10b981', data: [] },
      { label: 'Prediction (Total)', type: 'bar', backgroundColor: 'rgba(245, 158, 11, 0.6)', borderColor: '#f59e0b', borderWidth: 1, barThickness: 16, data: [] }
    ]
  },
  options: { responsive: true, plugins: { legend: { position: 'top' } } }
});

async function checkDatabaseOrders() {
  try {
    console.log('Checking database orders...');
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/sync-orders`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to check database orders');
    }
    
    const result = await response.json();
    console.log('Database orders result:', result);
    
    // Show user-friendly database information
    let message = `Database Summary:\n\n`;
    message += `Total orders: ${result.totalOrdersInDB}\n`;
    message += `Today's orders: ${result.todayOrders}\n\n`;
    
    if (result.recentOrders && result.recentOrders.length > 0) {
      message += `Recent Activity:\n`;
      result.recentOrders.slice(0, 5).forEach(order => {
        const date = new Date(order.createdAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric'
        });
        const status = order.status === 'Completed' ? 'Completed' : order.status === 'Pending' ? 'Pending' : order.status;
        message += `• ${date} - ₱${order.net_total} ${status}\n`;
      });
    } else {
      message += `No recent orders found.`;
    }
    
    Swal.fire({
      icon: 'info',
      title: 'Database Orders Check',
      text: message,
      showConfirmButton: true,
      confirmButtonText: 'OK'
    });
    
  } catch (error) {
    console.error('Error checking database orders:', error);
    Swal.fire({
      icon: 'error',
      title: 'Failed to Check Database',
      text: error.message || 'An error occurred while checking database orders',
      confirmButtonText: 'OK'
    });
  }
}

async function aggregateAllHistoricalSales() {
  try {
    console.log('Aggregating all historical sales data...');
    
    // Show loading message
    Swal.fire({
      title: 'Processing Historical Sales...',
      text: 'This may take a moment while we process all your orders',
      allowOutsideClick: false,
      showConfirmButton: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/aggregate-sales`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to aggregate historical sales data');
    }
    
    const result = await response.json();
    console.log('Historical aggregation result:', result);
    
    // Show user-friendly success message
    let message = `Successfully processed ${result.processedDays} days of sales data!\n\n`;
    if (result.results && result.results.length > 0) {
      message += `Recent Sales Activity:\n`;
      result.results.slice(-5).forEach(day => {
        const date = new Date(day.date).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        });
        message += `• ${date}: ${day.orders} orders - ₱${day.net_sales.toFixed(2)}\n`;
      });
    }
    
    Swal.fire({
      icon: 'success',
      title: 'All Sales Updated!',
      text: message,
      showConfirmButton: true,
      confirmButtonText: 'OK'
    });
    
    // Refresh the sales overview chart
    await loadSalesOverview();
    
  } catch (error) {
    console.error('Error aggregating historical sales:', error);
    Swal.fire({
      icon: 'error',
      title: 'Failed to Aggregate Historical Sales',
      text: error.message || 'An error occurred while processing historical sales data',
      confirmButtonText: 'OK'
    });
  }
}

async function aggregateTodaySales() {
  try {
    console.log('Aggregating today\'s sales data...');
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/aggregate-today`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error('Failed to aggregate sales data');
    }
    
    const result = await response.json();
    console.log('Aggregation result:', result);
    
    // Show user-friendly success message
    let message = `Successfully updated today's sales data!\n\n`;
    message += `Processed ${result.processedOrders} orders\n`;
    message += `Total sales: ₱${result.grossSales || 0}\n`;
    message += `Net sales: ₱${result.netSales || 0}`;
    
    Swal.fire({
      icon: 'success',
      title: 'Today\'s Sales Updated!',
      text: message,
      showConfirmButton: true,
      confirmButtonText: 'OK'
    });
    
    // Refresh the sales overview chart
    await loadSalesOverview();
    
  } catch (error) {
    console.error('Error aggregating sales:', error);
    Swal.fire({
      icon: 'error',
      title: 'Failed to Update Sales',
      text: error.message || 'An error occurred while updating sales data',
      confirmButtonText: 'OK'
    });
  }
}

async function loadSalesOverview() {
  try {
    // Try auth endpoint first; if unauthorized, fall back to public endpoint
    let res;
    try {
      res = await apiFetch('/dashboard/sales-overview');
    } catch (e) {
      // retry without auth requirement
      const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/sales-overview-public`);
      if (!r.ok) throw new Error('API error');
      res = await r.json();
    }
    const days = res.days || [];
    // Directly use API sequence (already last 7 days in order)
    const labels = days.map(d => {
      const dt = new Date(`${d.day}T00:00:00`);
      return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
    });
    const online = days.map(d => Number(d.online || 0));
    const instore = days.map(d => Number(d.instore || 0));

    // Forecast next 2 days using rule-based heuristics (no ML model)
    const total = online.map((v, idx) => v + (instore[idx] || 0));
    const forecast = ruleBasedForecast(total, 2).map(v => Math.max(0, v));

    // Build extended labels for the next 7 days
    const extendedLabels = [...labels];
    for (let i = 1; i <= 2; i++) {
      const dt = new Date();
      dt.setDate(dt.getDate() + i);
      extendedLabels.push(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()]);
    }

    // Extend datasets with nulls so bars only show for actual days
    const padNulls = (arr, extra) => arr.concat(Array.from({ length: extra }, () => null));

    salesChart.data.labels = extendedLabels;
    salesChart.data.datasets[0].data = padNulls(online, 2);
    salesChart.data.datasets[1].data = padNulls(instore, 2);
    // Show prediction bars only for the last 2 slots (future days), keep nulls for history so bars don't overlap
    salesChart.data.datasets[2].data = Array(online.length).fill(null).concat(forecast);
    salesChart.update();
  } catch (_e) {
    salesChart.data.datasets[0].data = [65, 78, 80, 56, 90, 110, 130];
    salesChart.data.datasets[1].data = [50, 60, 70, 85, 100, 95, 88];
    salesChart.data.datasets[2].data = [];
    salesChart.update();
  }
}

// Rule-based forecast: repeat day-of-week pattern with gentle trend and smoothing
function ruleBasedForecast(values, k) {
  const n = values.length;
  if (n === 0) return Array(k).fill(0);
  const avg = values.reduce((a,b)=>a+b,0) / n;
  // Smooth with 3-point moving average to reduce spikes
  const smoothed = values.map((v, i, arr) => {
    const a = arr[Math.max(0, i-1)];
    const b = v;
    const c = arr[Math.min(n-1, i+1)];
    return (a + b + c) / 3;
  });
  // Day-of-week weights from smoothed values (relative to average)
  const weights = smoothed.map(v => (avg ? v / avg : 1));
  // Recent trend: average daily change over last 3 days
  const recentChange = n >= 4 ? (smoothed[n-1] - smoothed[n-4]) / 3 : 0;
  const maxTrendPerDay = avg * 0.1; // cap trend magnitude (10% of avg per day)
  const trendPerDay = Math.max(-maxTrendPerDay, Math.min(maxTrendPerDay, recentChange));

  const result = [];
  for (let i = 0; i < k; i++) {
    const w = weights[i % weights.length] || 1;
    const base = avg * w;
    const withTrend = base + trendPerDay * (i + 1);
    // Boundaries: no negatives; cap to 3x average to avoid runaway
    result.push(Math.max(0, Math.min(withTrend, avg * 3)));
  }
  return result;
}

// --------------------------- INIT ---------------------------
// Initialize current date display and start updating time every second
// Wait for DOM to be ready before starting the interval
function initializeDateDisplay() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      startDateUpdateInterval();
    });
  } else {
    // DOM is already ready
    startDateUpdateInterval();
  }
  
  // Restart interval when window gains focus (in case it was paused)
  window.addEventListener('focus', () => {
    if (!dateUpdateInterval) {
      startDateUpdateInterval();
    }
  });
}

initializeDateDisplay();
// Set user/admin name from stored authUser
try {
  const u = JSON.parse(localStorage.getItem('authUser') || '{}');
  const nameEl = document.getElementById('userName');
  if (nameEl) nameEl.textContent = u.name || u.email || 'Admin';
} catch (_e) {
  const nameEl = document.getElementById('userName');
  if (nameEl) nameEl.textContent = 'Admin';
}

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem('authToken');
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${window.APP_CONFIG.API_BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    let errorMessage = 'API error';
    try {
      const errorData = await res.json();
      errorMessage = errorData.message || errorMessage;
    } catch (_e) {
      errorMessage = `HTTP ${res.status}: ${res.statusText}`;
    }
    const error = new Error(errorMessage);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function loadFromBackend() {
  try {
    document.body.style.cursor = 'progress';
    // Try auth endpoints first; fall back to public where available
    const metricsPromise = apiFetch('/dashboard/metrics').catch(async () => {
      const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/metrics`);
      if (!r.ok) throw new Error('metrics');
      return r.json();
    });
    const suppliersPromise = apiFetch('/suppliers');
    const ordersPromise = apiFetch('/orders?page=1&pageSize=100').catch(async () => {
      const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/public?page=1&pageSize=100`);
      if (!r.ok) throw new Error('orders');
      return r.json();
    });
    const lowStockPromise = apiFetch('/products/low-stock?threshold=5').catch(async () => {
      const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/low-stock/public?threshold=5`);
      if (!r.ok) throw new Error('low-stock');
      return r.json();
    });

    const [metrics, suppliersRes, ordersRes, lowStockRes] = await Promise.all([
      metricsPromise, suppliersPromise, ordersPromise, lowStockPromise
    ]);

    // Products are now loaded via DataTables server-side pagination
    // No need to load them here

    suppliers = (suppliersRes.suppliers || []).map(s => ({ id: s.id, name: s.name, contact: s.contact, items: s.items || [], lastDelivery: s.last_delivery || null }));
    orders = (ordersRes.orders || []).map(o => ({ 
      id: o.id, 
      displayId: o.order_code || `ORD${o.id}`, 
      customer: o.name, 
      contact: o.contact, 
      address: o.address, 
      total: Number(o.totalPrice || 0), 
      discount: Number(o.discount || 0), 
      netTotal: Number(o.net_total || 0), 
      status: o.status, 
      type: o.type, 
      payment: o.payment, 
      ref: o.ref, 
      payment_proof_image_url: o.payment_proof_image_url || null,
      payment_proof_public_id: o.payment_proof_public_id || null,
      createdAt: o.createdAt 
    }));

    localStorage.setItem('suppliers', JSON.stringify(suppliers));
    localStorage.setItem('orders', JSON.stringify(orders));

    // apply metrics instantly
    document.getElementById('totalSales').textContent = `₱${Number(metrics.totalSales || 0).toFixed(2)}`;
    document.getElementById('totalOrders').textContent = Number(metrics.totalOrders || 0);
    document.getElementById('totalCustomers').textContent = Number(metrics.customers || 0);
    
    // Use low stock data from API
    const lowStockCount = lowStockRes.total || 0;
    console.log('Low stock count from loadFromBackend:', lowStockCount);
    document.getElementById('lowStockCount').textContent = lowStockCount;
    document.getElementById('notifCount').textContent = lowStockCount > 99 ? '99+' : String(lowStockCount);
    
    // Update low stock list with API data
    const lowStockList = document.getElementById('lowStockList');
    if (lowStockRes.products && lowStockRes.products.length > 0) {
      const limited = lowStockRes.products.slice(0, dashboardLowStockDisplayLimit);
      const extraCount = Math.max(lowStockRes.products.length - dashboardLowStockDisplayLimit, 0);
      const itemsHtml = limited.map(item => {
        const actualStock = Math.max(0, item.stock || 0); // Ensure stock is never negative
        const stockText = actualStock === 0 ? 'Out of Stock' : `${actualStock} left`;
        const stockColor = actualStock === 0 ? 'text-red-600' : 'text-yellow-600';
        const productId = item.id || item._id || '';
        return `<li class="flex justify-between items-center">
          <span>${item.name} <span class="${stockColor}">(${stockText})</span></span>
          <button class="text-indigo-600 ml-2" onclick="openRestockModalFromLowStock('${productId}')">Receive</button>
        </li>`;
      }).join('');
      const extraHtml = extraCount > 0 ? `<li class="mt-2 text-sm text-gray-600">and ${extraCount} more… <button class="text-blue-600" onclick="showMoreLowStockItems()">Show 5 more</button></li>` : '';
      lowStockList.innerHTML = itemsHtml + extraHtml;
    } else {
      lowStockList.innerHTML = '<li>No low stock items</li>';
    }
  } catch (e) {
    console.error('Failed loading from API:', e);
  Swal.fire({ icon: 'info', title: 'Offline', text: 'Showing local data if available.' });
  } finally {
    document.body.style.cursor = 'default';
  }
}

async function saveToBackend() {
  try {
    await apiFetch('/sync/save', {
      method: 'POST',
      body: JSON.stringify({ products, suppliers, orders })
    });
  } catch (_e) {
    // ignore for now; could show toast
  }
}

async function init() {
  await loadFromBackend();
  updateDashboard();
  renderInventory();
  renderSuppliers();
  renderOrders();
  setupScannerInputListener();
  renderScannedProducts();
  
  // Setup process sale and clear buttons
  const processBtn = document.getElementById('processSaleBtn');
  if (processBtn) {
    processBtn.addEventListener('click', processScannedSale);
  }
  
  const clearBtn = document.getElementById('clearScannedBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearScannedProducts);
  }

  // Periodically refresh orders so mobile updates (e.g., payment refs) appear
  setInterval(async () => {
    try {
      await refreshOrdersOnly();
    } catch (_e) {
      // ignore periodic failures
    }
  }, 30000); // 30s
  
  // Periodically clean image cache to prevent memory issues
  setInterval(() => {
    clearImageCache();
  }, 60000); // 1 minute
}

async function refreshOrdersOnly() {
  let ordersRes;
  try {
    ordersRes = await apiFetch('/orders?page=1&pageSize=100');
  } catch (_e) {
    const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/public?page=1&pageSize=100`);
    if (!r.ok) throw new Error('orders');
    ordersRes = await r.json();
  }
  orders = (ordersRes.orders || []).map(o => ({ 
    id: o.id, 
    displayId: o.order_code || `ORD${o.id}`, 
    customer: o.name, 
    contact: o.contact, 
    address: o.address, 
    total: Number(o.totalPrice || 0), 
    discount: Number(o.discount || 0), 
    netTotal: Number(o.net_total || 0), 
    status: o.status, 
    type: o.type, 
    payment: o.payment, 
    ref: o.ref, 
    payment_proof_image_url: o.payment_proof_image_url || null,
    payment_proof_public_id: o.payment_proof_public_id || null,
    createdAt: o.createdAt 
  }));
  localStorage.setItem('orders', JSON.stringify(orders));
  renderOrders();
  updateDashboard();
}

// Refresh only products
async function refreshInventoryOnly() {
  const productsRes = await apiFetch('/products');
  products = (productsRes.products || []).map(p => ({
    id: p.id,
    handle: p.handle,
    sku: p.sku,
    name: p.name,
    category: p.category,
    barcode: p.barcode || '',
    price: Number(p.price || 0),
    stock: Number(p.stock || 0),
    lowStockThreshold: Number(p.low_stock_threshold || 5),
    available: Boolean(p.available_for_sale),
    image_url: p.image_url || null
  }));
  localStorage.setItem('products', JSON.stringify(products));
  renderInventory();
  updateDashboard();
}

// Refresh only suppliers
async function refreshSuppliersOnly() {
  const suppliersRes = await apiFetch('/suppliers');
  suppliers = (suppliersRes.suppliers || []).map(s => ({ id: s.id, name: s.name, contact: s.contact, items: s.items || [], lastDelivery: s.last_delivery || null }));
  localStorage.setItem('suppliers', JSON.stringify(suppliers));
  renderSuppliers();
}

// Refresh all sections
async function refreshAll() {
  await loadFromBackend();
  renderInventory();
  renderSuppliers();
  renderOrders();
  updateDashboard();
}

function setOrdersStatusFilter(kind) {
  showSection('ordersSection');
  if (!ordersDT) { renderOrders(); }
  if (!ordersDT) return;
  
  // Clear all filters first
  ordersDT.column(8).search('').draw();
  
  if (kind === 'pending') {
    ordersDT.column(8).search('pending', true, true).draw();
  } else if (kind === 'processing') {
    ordersDT.column(8).search('processing', true, true).draw();
  } else if (kind === 'completed') {
    ordersDT.column(8).search('completed', true, true).draw();
  } else if (kind === 'cancelled') {
    ordersDT.column(8).search('cancelled', true, true).draw();
  } else {
    // Show all orders
    ordersDT.column(8).search('').draw();
  }
}

init();

// Initialize comparison chart after a short delay to ensure DOM is ready
setTimeout(() => {
  initializeComparisonChart();
}, 500);

// --------------------------- DATE FILTER UI HANDLERS ---------------------------
// Function to update the current date/time display
// Always shows today's date and current time in Manila timezone, regardless of date filter
function updateCurrentDateDisplay() {
  const currentDateEl = document.getElementById('currentDate');
  if (!currentDateEl) return;
  
  // Always show today's date and current time in Manila timezone
  currentDateEl.textContent = formatDateWithDay(new Date());
}

// Set up interval to update time every second
let dateUpdateInterval = null;

function startDateUpdateInterval() {
  // Clear existing interval if any
  if (dateUpdateInterval) {
    clearInterval(dateUpdateInterval);
    dateUpdateInterval = null;
  }
  
  // Check if the element exists before starting
  const currentDateEl = document.getElementById('currentDate');
  if (!currentDateEl) {
    console.warn('currentDate element not found, retrying in 100ms...');
    setTimeout(startDateUpdateInterval, 100);
    return;
  }
  
  // Update immediately
  updateCurrentDateDisplay();
  // Then update every second
  dateUpdateInterval = setInterval(() => {
    updateCurrentDateDisplay();
  }, 1000);
  console.log('Date update interval started');
}

function onDateFilterChange(value) {
  activeDateFilter = value || null;
  // Note: updateCurrentDateDisplay() is not needed here since the interval handles it
  // The time display always shows today's date/time, independent of the filter
  renderOrders();
  updateDashboard();
  // Also load daily sales summary and orders-by-date table
  loadDailySalesSummary();
  loadOrdersByDateTable();
  // Analytics will automatically update via loadDailySalesSummary which calls updateSalesAnalytics
  // Reload top 5 items and chart if analytics section is visible
  if (!document.getElementById('analyticsSection').classList.contains('hidden')) {
    loadTop5Items();
    updateSalesByItemChart();
  }
}

// --------------------------- DAILY SALES SUMMARY ---------------------------
async function loadDailySalesSummary() {
  try {
    const token = localStorage.getItem('authToken');
    const date = activeDateFilter || new Date().toISOString().slice(0, 10);
    const res = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/sales-by-date?date=${date}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    const has = (data.rows && data.rows.length);
    document.getElementById('dsEmpty').classList.toggle('hidden', !!has);
    const row = has ? data.rows[0] : null;
    const today = data.todayData || null;
    const isToday = data.isToday || false;
    
    // Update date label to show comparison context
    const dateLabel = isToday ? `${date} (Today)` : `${date} vs Today`;
    document.getElementById('dsDate').textContent = dateLabel;
    const fmt = (n) => (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    
    // Helper function to calculate and display change
    const displayChange = (selectedValue, todayValue, elementId, isPercent = false, reverseColor = false) => {
      // Don't show comparison if selected date is today
      if (isToday) {
        const changeElement = document.getElementById(elementId);
        changeElement.textContent = '';
        changeElement.className = 'text-xs mr-1';
        return;
      }
      
      const selected = Number(selectedValue || 0);
      const todayVal = Number(todayValue || 0);
      const change = selected - todayVal;
      const changeElement = document.getElementById(elementId);
      
      if (!today || change === 0) {
        changeElement.textContent = '';
        changeElement.className = 'text-xs mr-1';
        return;
      }
      
      const isIncrease = change > 0;
      // Calculate percentage change, handling division by zero
      let changePercent = 0;
      let showPercent = true;
      if (todayVal !== 0) {
        changePercent = (change / todayVal) * 100;
      } else if (selected !== 0) {
        // If today was 0 and selected date is not, show "New" instead of percentage
        showPercent = false;
      }
      
      // For refunds, discounts, and cost of goods, reverse the color logic
      // Note: When comparing selected date vs today, we want to show if selected date is better than today
      const isGood = reverseColor ? !isIncrease : isIncrease;
      
      if (isPercent) {
        // For margin, show percentage point change
        changeElement.textContent = `${isIncrease ? '+' : ''}${change.toFixed(2)}pp`;
      } else if (!showPercent && todayVal === 0 && selected !== 0) {
        // Show "New" when today was 0 and selected date has a value
        changeElement.textContent = 'New';
      } else {
        // For monetary values, show percentage change
        changeElement.textContent = `${isIncrease ? '+' : ''}${changePercent.toFixed(1)}%`;
      }
      
      changeElement.className = `text-xs mr-1 font-semibold ${isGood ? 'text-green-600' : 'text-red-600'}`;
    };
    
    // Display values
    document.getElementById('dsGross').textContent = fmt(row?.gross_sales);
    document.getElementById('dsRefunds').textContent = fmt(row?.refunds);
    document.getElementById('dsDiscounts').textContent = fmt(row?.discounts);
    document.getElementById('dsNet').textContent = fmt(row?.net_sales);
    document.getElementById('dsCogs').textContent = fmt(row?.cost_of_goods);
    document.getElementById('dsProfit').textContent = fmt(row?.gross_profit);
    document.getElementById('dsMargin').textContent = (Number(row?.margin_percent || 0)).toFixed(2);
    document.getElementById('dsTaxes').textContent = fmt(row?.taxes);
    
    // Display changes (comparing selected date vs today)
    // For sales, profit, net sales: higher than today is good (green)
    displayChange(row?.gross_sales, today?.gross_sales, 'dsGrossChange');
    displayChange(row?.net_sales, today?.net_sales, 'dsNetChange');
    displayChange(row?.gross_profit, today?.gross_profit, 'dsProfitChange');
    // For refunds, discounts, cost of goods: lower than today is good (green)
    displayChange(row?.refunds, today?.refunds, 'dsRefundsChange', false, true);
    displayChange(row?.discounts, today?.discounts, 'dsDiscountsChange', false, true);
    displayChange(row?.cost_of_goods, today?.cost_of_goods, 'dsCogsChange', false, true);
    // For margin, we compare the percentage points (higher than today is good)
    displayChange(row?.margin_percent, today?.margin_percent, 'dsMarginChange', true);
    // For taxes, lower than today is good (green)
    displayChange(row?.taxes, today?.taxes, 'dsTaxesChange', false, true);
    
    // Update analytics section
    updateSalesAnalytics(row, today, isToday, date);
  } catch (error) {
    console.error('Error loading daily sales summary:', error);
    // Still try to update analytics with null data to clear it
    updateSalesAnalytics(null, null, false, '');
  }
}

// --------------------------- ORDERS BY DATE TABLE ---------------------------
async function loadOrdersByDateTable() {
  try {
    const token = localStorage.getItem('authToken');
    const date = activeDateFilter || new Date().toISOString().slice(0, 10);
    const res = await fetch(`${window.APP_CONFIG.API_BASE_URL}/dashboard/orders-by-date?date=${date}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    document.getElementById('obdTotalOrders').textContent = Number(data.total_orders || 0).toLocaleString();
    const fmt = (n) => (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('obdGross').textContent = fmt(data.gross_sales);
    document.getElementById('obdDiscounts').textContent = fmt(data.discounts);
    document.getElementById('obdNet').textContent = fmt(data.net_sales);

    const body = document.getElementById('ordersByDateBody');
    body.innerHTML = '';
    const rows = Array.isArray(data.rows) ? data.rows : [];
    document.getElementById('ordersByDateEmpty').classList.toggle('hidden', rows.length > 0);
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="px-3 py-2">${r.order_code || r.id}</td>
        <td class="px-3 py-2">${r.customer || ''}</td>
        <td class="px-3 py-2 text-right">₱${fmt(r.net_total)}</td>
        <td class="px-3 py-2">${new Date(r.createdAt).toLocaleTimeString()}</td>
        <td class="px-3 py-2">${(r.status || '').toString()}</td>
      `;
      body.appendChild(tr);
    }
  } catch (_e) {
    // ignore
  }
}

// --------------------------- SALES ANALYTICS ---------------------------
let comparisonChart = null;
let salesByItemChart = null;

function initializeComparisonChart() {
  const ctx = document.getElementById('comparisonChart');
  if (!ctx) return;
  
  // Destroy existing chart if it exists
  if (comparisonChart) {
    comparisonChart.destroy();
    comparisonChart = null;
  }
  
  comparisonChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['Gross Sales', 'Net Sales', 'Gross Profit', 'Cost of Goods'],
      datasets: [
        {
          label: 'Selected Date',
          backgroundColor: 'rgba(59, 130, 246, 0.7)',
          borderColor: 'rgb(59, 130, 246)',
          borderWidth: 1,
          data: [0, 0, 0, 0]
        },
        {
          label: 'Today',
          backgroundColor: 'rgba(16, 185, 129, 0.7)',
          borderColor: 'rgb(16, 185, 129)',
          borderWidth: 1,
          data: [0, 0, 0, 0]
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.dataset.label + ': ₱' + Number(context.parsed.y).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              });
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function(value) {
              return '₱' + Number(value).toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
              });
            }
          }
        }
      }
    }
  });
}

function updateSalesAnalytics(selectedData, todayData, isToday, date) {
  console.log('updateSalesAnalytics called with:', { selectedData, todayData, isToday, date });
  
  if (!selectedData) {
    // Clear analytics if no data
    const analyticsNetSales = document.getElementById('analyticsNetSales');
    const analyticsProfit = document.getElementById('analyticsProfit');
    const analyticsMargin = document.getElementById('analyticsMargin');
    const analyticsDateLabel = document.getElementById('analyticsDateLabel');
    const performanceBreakdown = document.getElementById('performanceBreakdown');
    const analyticsInsights = document.getElementById('analyticsInsights');
    
    if (analyticsNetSales) analyticsNetSales.textContent = '₱0.00';
    if (analyticsProfit) analyticsProfit.textContent = '₱0.00';
    if (analyticsMargin) analyticsMargin.textContent = '0.00%';
    if (analyticsDateLabel) analyticsDateLabel.textContent = '';
    if (performanceBreakdown) performanceBreakdown.innerHTML = '';
    if (analyticsInsights) analyticsInsights.innerHTML = '<p class="text-gray-500">No data available for analysis.</p>';
    return;
  }

  const fmt = (n) => (Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPercent = (n) => (Number(n || 0)).toFixed(2);
  
  const selected = {
    gross_sales: Number(selectedData.gross_sales || 0),
    net_sales: Number(selectedData.net_sales || 0),
    gross_profit: Number(selectedData.gross_profit || 0),
    cost_of_goods: Number(selectedData.cost_of_goods || 0),
    margin_percent: Number(selectedData.margin_percent || 0),
    discounts: Number(selectedData.discounts || 0),
    refunds: Number(selectedData.refunds || 0)
  };

  const today = todayData ? {
    gross_sales: Number(todayData.gross_sales || 0),
    net_sales: Number(todayData.net_sales || 0),
    gross_profit: Number(todayData.gross_profit || 0),
    cost_of_goods: Number(todayData.cost_of_goods || 0),
    margin_percent: Number(todayData.margin_percent || 0),
    discounts: Number(todayData.discounts || 0),
    refunds: Number(todayData.refunds || 0)
  } : null;

  // Update KPI cards (these elements may not exist in analytics section)
  const analyticsNetSales = document.getElementById('analyticsNetSales');
  const analyticsProfit = document.getElementById('analyticsProfit');
  const analyticsMargin = document.getElementById('analyticsMargin');
  const analyticsDateLabel = document.getElementById('analyticsDateLabel');
  
  if (analyticsNetSales) analyticsNetSales.textContent = '₱' + fmt(selected.net_sales);
  if (analyticsProfit) analyticsProfit.textContent = '₱' + fmt(selected.gross_profit);
  if (analyticsMargin) analyticsMargin.textContent = fmtPercent(selected.margin_percent) + '%';
  if (analyticsDateLabel) analyticsDateLabel.textContent = isToday ? 'Viewing Today\'s Data' : `Comparing ${date} with Today`;

  // Update comparison chart
  if (!comparisonChart) {
    initializeComparisonChart();
  }
  if (comparisonChart) {
    try {
      comparisonChart.data.datasets[0].data = [
        selected.gross_sales,
        selected.net_sales,
        selected.gross_profit,
        selected.cost_of_goods
      ];
      comparisonChart.data.datasets[1].data = today ? [
        today.gross_sales,
        today.net_sales,
        today.gross_profit,
        today.cost_of_goods
      ] : [0, 0, 0, 0];
      comparisonChart.update('none'); // Use 'none' mode for smoother updates
    } catch (error) {
      console.error('Error updating comparison chart:', error);
    }
  } else {
    console.warn('Comparison chart not initialized');
  }

  // Update performance breakdown
  const breakdown = document.getElementById('performanceBreakdown');
  if (!breakdown) {
    console.warn('Performance breakdown element not found');
    return;
  }
  breakdown.innerHTML = '';
  
  const metrics = [
    { label: 'Gross Sales', selected: selected.gross_sales, today: today?.gross_sales, icon: 'bi-cash-stack' },
    { label: 'Net Sales', selected: selected.net_sales, today: today?.net_sales, icon: 'bi-graph-up' },
    { label: 'Gross Profit', selected: selected.gross_profit, today: today?.gross_profit, icon: 'bi-cash-coin' },
    { label: 'Cost of Goods', selected: selected.cost_of_goods, today: today?.cost_of_goods, icon: 'bi-box', reverse: true },
    { label: 'Discounts', selected: selected.discounts, today: today?.discounts, icon: 'bi-ticket-perforated', reverse: true },
    { label: 'Refunds', selected: selected.refunds, today: today?.refunds, icon: 'bi-arrow-counterclockwise', reverse: true }
  ];

  metrics.forEach(metric => {
    // Always show metrics if we have selected data
    const div = document.createElement('div');
    div.className = 'flex items-center justify-between p-2 bg-white rounded border';
    div.innerHTML = `
      <div class="flex items-center gap-2">
        <i class="bi ${metric.icon} text-lg"></i>
        <span class="text-sm font-medium">${metric.label}</span>
      </div>
      <div class="text-right">
        <div class="text-sm font-semibold">₱${fmt(metric.selected)}</div>
      </div>
    `;
    breakdown.appendChild(div);
  });

  // Generate insights
  const insights = document.getElementById('analyticsInsights');
  if (!insights) {
    console.warn('Analytics insights element not found');
    return;
  }
  insights.innerHTML = '';
  
  if (isToday) {
    insights.innerHTML = '<p class="text-gray-600">Viewing today\'s data. Select a different date to see comparison insights.</p>';
    return;
  }

  if (!today) {
    insights.innerHTML = '<p class="text-gray-600">No data available for today to generate insights.</p>';
    return;
  }

  const insightsList = [];
  
  // Net Sales insight
  if (selected.net_sales > today.net_sales) {
    insightsList.push(`<i class="bi bi-check-circle"></i> <strong>Net Sales</strong> were higher than today, indicating strong performance.`);
  } else if (selected.net_sales < today.net_sales) {
    insightsList.push(`<i class="bi bi-exclamation-triangle"></i> <strong>Net Sales</strong> were lower than today.`);
  }

  // Profit insight
  if (selected.gross_profit > today.gross_profit) {
    insightsList.push(`<i class="bi bi-cash-coin"></i> <strong>Gross Profit</strong> was higher, showing better profitability.`);
  } else if (selected.gross_profit < today.gross_profit) {
    insightsList.push(`<i class="bi bi-graph-down-arrow"></i> <strong>Gross Profit</strong> was lower than today.`);
  }

  // Margin insight
  if (selected.margin_percent > today.margin_percent) {
    insightsList.push(`<i class="bi bi-graph-up"></i> <strong>Profit Margin</strong> was higher, indicating better cost efficiency.`);
  } else if (selected.margin_percent < today.margin_percent) {
    insightsList.push(`<i class="bi bi-graph-up"></i> <strong>Profit Margin</strong> was lower.`);
  }

  // Cost efficiency
  if (selected.cost_of_goods < today.cost_of_goods && selected.net_sales > 0) {
    insightsList.push(`<i class="bi bi-lightbulb"></i> <strong>Cost of Goods</strong> was lower, showing better inventory management.`);
  } else if (selected.cost_of_goods > today.cost_of_goods) {
    insightsList.push(`<i class="bi bi-exclamation-triangle"></i> <strong>Cost of Goods</strong> was higher, which may have impacted profitability.`);
  }

  // Discount analysis
  if (selected.discounts > today.discounts) {
    insightsList.push(`<i class="bi bi-ticket-perforated"></i> <strong>Discounts</strong> were higher, potentially driving more sales volume.`);
  }


  insightsList.forEach(insight => {
    const p = document.createElement('p');
    p.className = 'flex items-start gap-2';
    p.innerHTML = insight;
    insights.appendChild(p);
  });
}

// Helper: fetch all products via lazy endpoint (auth->public)
async function fetchAllProducts() {
  try {
    const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/lazy`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` } });
    if (r.ok) { const j = await r.json(); return j.products || []; }
  } catch (_) {}
  const rp = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/lazy/public`);
  if (rp.ok) { const j2 = await rp.json(); return j2.products || []; }
  return [];
}

// --------------------------- TOP 5 ITEMS & SALES BY ITEM CHART ---------------------------
async function loadTop5Items() {
  try {
    // Fetch orders to calculate top items by sales
    let ordersRes;
    try {
      ordersRes = await apiFetch('/orders?page=1&pageSize=1000');
    } catch (_e) {
      const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/public?page=1&pageSize=1000`);
      if (!r.ok) throw new Error('orders');
      ordersRes = await r.json();
    }

    const allOrders = ordersRes.orders || [];
    
    // Calculate item sales from order items
    const itemSalesMap = new Map();
    
    for (const order of allOrders) {
      // Fetch order items
      let items = [];
      try {
        const itemsRes = await apiFetch(`/orders/${order.id}/items`);
        items = itemsRes.items || [];
      } catch (_eItemsAuth) {
        try {
          const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/${order.id}/items/public`);
          if (r.ok) {
            const j = await r.json();
            items = j.items || [];
          }
        } catch (_) {}
      }
      
      // Aggregate sales by product name
      items.forEach(item => {
        const productName = item.product_name || item.name || 'Unknown Product';
        const quantity = Number(item.quantity || 0);
        const totalPrice = Number(item.total_price || quantity * (item.unit_price || item.price || 0));
        
        if (itemSalesMap.has(productName)) {
          const existing = itemSalesMap.get(productName);
          existing.itemsSold += quantity;
          existing.netSales += totalPrice;
        } else {
          itemSalesMap.set(productName, {
            name: productName,
            itemsSold: quantity,
            netSales: totalPrice
          });
        }
      });
    }
    
    // Get top 5 items by net sales
    const top5Items = Array.from(itemSalesMap.values())
      .sort((a, b) => b.netSales - a.netSales)
      .slice(0, 5);
    
    // Display top 5 items in table format
    const top5List = document.getElementById('top5ItemsList');
    if (top5List) {
      if (top5Items.length === 0) {
        top5List.innerHTML = '<tr><td colspan="3" class="text-center py-4 text-gray-500 text-sm">No sales data available</td></tr>';
      } else {
        top5List.innerHTML = top5Items.map((item) => `
          <tr class="border-b hover:bg-gray-50">
            <td class="py-2 px-2">${item.name || 'Unknown Product'}</td>
            <td class="py-2 px-2 text-right">${Number(item.itemsSold || 0).toLocaleString('en-US')}</td>
            <td class="py-2 px-2 text-right font-semibold">₱${Number(item.netSales || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          </tr>
        `).join('');
      }
    }
    
    // Store top 5 items for chart use
    window.top5ItemsData = top5Items;
    
    // Update chart if it exists
    if (salesByItemChart) {
      updateSalesByItemChart();
    }
  } catch (error) {
    console.error('Error loading top 5 items:', error);
    const top5List = document.getElementById('top5ItemsList');
    if (top5List) {
      top5List.innerHTML = '<p class="text-gray-500 text-sm">Error loading data</p>';
    }
  }
}

function initializeSalesByItemChart() {
  const ctx = document.getElementById('salesByItemChart');
  if (!ctx) return;
  
  // Destroy existing chart if it exists
  if (salesByItemChart) {
    salesByItemChart.destroy();
  }
  
  const colors = ['#9CA3AF', '#86EFAC', '#93C5FD', '#F9A8D4', '#FDE047']; // Grey, Light Green, Light Blue, Pink, Yellow
  
  salesByItemChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: []
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              return context.dataset.label + ': ₱' + Number(context.parsed.y).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              });
            }
          }
        }
      },
      scales: {
        x: {
          stacked: true,
          ticks: {
            font: {
              size: 10
            },
            maxRotation: 45,
            minRotation: 45
          }
        },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: {
            font: {
              size: 10
            },
            callback: function(value) {
              return '₱' + Number(value).toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
              });
            }
          }
        }
      }
    }
  });
  
  updateSalesByItemChart();
}

async function updateSalesByItemChart() {
  if (!salesByItemChart) {
    initializeSalesByItemChart();
    return;
  }
  
  try {
    const days = parseInt(document.getElementById('salesChartDays')?.value || '30');
    const chartType = document.getElementById('salesChartType')?.value || 'bar';
    
    // Update chart type
    salesByItemChart.config.type = chartType;
    
    // Fetch orders for the specified period
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    let ordersRes;
    try {
      ordersRes = await apiFetch(`/orders?page=1&pageSize=1000`);
    } catch (_e) {
      const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/public?page=1&pageSize=1000`);
      if (!r.ok) throw new Error('orders');
      ordersRes = await r.json();
    }

    const allOrders = (ordersRes.orders || []).filter(order => {
      if (!order.createdAt) return false;
      const orderDate = new Date(order.createdAt);
      return orderDate >= startDate && orderDate <= endDate;
    });
    
    // Get top 5 items if not already loaded
    if (!window.top5ItemsData || window.top5ItemsData.length === 0) {
      await loadTop5Items();
    }
    
    const top5Items = window.top5ItemsData || [];
    if (top5Items.length === 0) {
      salesByItemChart.data.labels = [];
      salesByItemChart.data.datasets = [];
      salesByItemChart.update();
      return;
    }
    
    const colors = ['#9CA3AF', '#86EFAC', '#93C5FD', '#F9A8D4', '#FDE047'];
    
    // Group orders by date
    const dateMap = new Map();
    
    // Initialize date map for all days in range
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateKey = d.toISOString().slice(0, 10);
      const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dateMap.set(dateKey, {
        date: dateKey,
        label: dateLabel,
        items: new Map()
      });
    }
    
    // Process orders and aggregate sales by item and date
    for (const order of allOrders) {
      const orderDate = new Date(order.createdAt);
      const dateKey = orderDate.toISOString().slice(0, 10);
      
      if (!dateMap.has(dateKey)) continue;
      
      const dayData = dateMap.get(dateKey);
      
      // Fetch order items
      let items = [];
      try {
        const itemsRes = await apiFetch(`/orders/${order.id}/items`);
        items = itemsRes.items || [];
      } catch (_eItemsAuth) {
        try {
          const r = await fetch(`${window.APP_CONFIG.API_BASE_URL}/orders/${order.id}/items/public`);
          if (r.ok) {
            const j = await r.json();
            items = j.items || [];
          }
        } catch (_) {}
      }
      
      // Aggregate sales by product name for this day
      items.forEach(item => {
        const productName = item.product_name || item.name || 'Unknown Product';
        const totalPrice = Number(item.total_price || (item.quantity || 0) * (item.unit_price || item.price || 0));
        
        // Only track top 5 items
        const top5Item = top5Items.find(t => t.name === productName);
        if (top5Item) {
          if (dayData.items.has(productName)) {
            dayData.items.set(productName, dayData.items.get(productName) + totalPrice);
          } else {
            dayData.items.set(productName, totalPrice);
          }
        }
      });
    }
    
    // Prepare chart data
    const sortedDates = Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    const labels = sortedDates.map(d => d.label);
    
    // Create datasets for each top 5 item
    const datasets = top5Items.map((item, index) => {
      const data = sortedDates.map(dayData => {
        return dayData.items.get(item.name) || 0;
      });
      
      return {
        label: item.name,
        data: data,
        backgroundColor: colors[index],
        borderColor: colors[index],
        borderWidth: 1
      };
    });
    
    // Update chart
    salesByItemChart.data.labels = labels;
    salesByItemChart.data.datasets = datasets;
    salesByItemChart.update();
  } catch (error) {
    console.error('Error updating sales by item chart:', error);
  }
}

// --------------------------- LOGOUT FUNCTION ---------------------------
function logout() {
  // Clear authentication token
  localStorage.removeItem('authToken');
  localStorage.removeItem('userName');
  
  // Redirect to login page
  window.location.href = '../index.html';
}


