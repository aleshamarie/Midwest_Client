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

// Inject a Logout button in the top-right corner
(function injectLogout() {
  const btn = document.createElement('button');
  btn.id = 'logoutBtn';
  btn.textContent = 'Logout';
  btn.style.position = 'fixed';
  btn.style.top = '12px';
  btn.style.right = '12px';
  btn.style.zIndex = '1000';
  btn.style.background = '#dc2626';
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.padding = '8px 12px';
  btn.style.borderRadius = '6px';
  btn.style.cursor = 'pointer';
  btn.addEventListener('click', () => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('authUser');
    window.location.href = '../index.html';
  });
  document.body.appendChild(btn);
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

// DataTables instances
let inventoryDT = null;
let ordersDT = null;
let suppliersDT = null;

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
const DASHBOARD_LOW_STOCK_LIMIT = 20; // how many low-stock items to show on dashboard
const LOW_STOCK_MODAL_LIMIT = 20; // how many items to show in modal by default
let showAllLowStockInModal = false;
// Active date filter in YYYY-MM-DD (null => no filter)
let activeDateFilter = null;

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
  if (id === 'inventorySection') {
    console.log('Rendering inventory section...');
    renderInventory();
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
    inventoryDT = $('#inventoryTable').DataTable({
      paging: true,
      pageLength: 25,
      searching: true,
      info: true,
      dom: 'ltip',
      order: [[1, 'asc']], // Sort by Product name
      columns: [
        { 
          title: 'Image', 
          orderable: false,
          data: null,
          render: function(data, type, row) {
            const baseUrl = window.APP_CONFIG.API_BASE_URL;
            const imageUrl = row.image_url ? `${baseUrl}${row.image_url}` : '../assets/images/Midwest.jpg';
            const placeholderUrl = row.placeholder_url ? `${baseUrl}${row.placeholder_url}` : '../assets/images/Midwest.jpg';
            const productName = row.name || 'Product';
            
            return `<img src="${placeholderUrl}" 
                         data-src="${imageUrl}" 
                         class="lazy-image w-12 h-12 object-cover rounded" 
                         alt="${productName}"
                         loading="lazy"
                         onerror="this.src='../assets/images/Midwest.jpg'">`;
          }
        },
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
            return `<button onclick="editProductFromTable('${row.id}')" class="text-blue-600">Edit</button>
                    <button onclick="deleteProductFromTable('${row.id}')" class="text-red-600 ml-2">Delete</button>
                    <button onclick="openRestockModalFromTable('${row.id}')" class="text-indigo-600 ml-2">Restock</button>
                    ${row.image_url ? `<button onclick="deleteProductImageFromTable('${row.id}')" class="text-orange-600 ml-2">Remove Image</button>` : ''}`;
          }
        }
      ],
      drawCallback: function() {
        // Lazy load images when table is drawn
        setTimeout(() => {
          lazyLoadImages();
          preloadCriticalImages();
        }, 100);
      },
      serverSide: false,
      processing: false,
      ajax: {
        url: `${window.APP_CONFIG.API_BASE_URL}/products/lazy`,
        type: 'GET',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('authToken')}`
        },
        data: function(d) {
          const search = d.search?.value || '';
          
          console.log('DataTables Ajax request:', {
            url: `${window.APP_CONFIG.API_BASE_URL}/products`,
            search: search
          });
          
          return {
            search: search
          };
        },
        error: function(xhr, error, thrown) {
          console.error('DataTables Ajax error:', {
            xhr: xhr,
            error: error,
            thrown: thrown,
            url: `${window.APP_CONFIG.API_BASE_URL}/products`
          });
          
          // Show user-friendly error message
          Swal.fire({ icon: 'error', title: 'Unable to load products', text: 'Unable to load products.' });
        },
        dataSrc: function(json) {
          console.log('DataTables response received:', json);
          
          // For client-side processing, return the products array directly
          return json.products || [];
        }
      },
      drawCallback: function() {
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
    console.log('editProductFromTable called with productId:', productId);
    const response = await apiFetch(`/products/${productId}`);
    const product = response.product;
    
    editProductIndex = null; // We'll handle this differently for server-side
    document.getElementById('productModalTitle').innerText = "Edit Product";
    document.getElementById('prodName').value = product.name;
    document.getElementById('prodCategory').value = product.category;
    document.getElementById('prodDescription').value = product.description || '';
    document.getElementById('prodPrice').value = product.price;
    document.getElementById('prodStock').value = product.stock;
    
    // Store the product ID for saving
    document.getElementById('productModal').setAttribute('data-product-id', productId);
    
    // Load existing image if available
    if (product.image_url) {
      showProductImagePreview(product.image_url);
    } else {
      resetProductImage();
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
    // For now, just refresh the table
    // In a real app, you'd call a DELETE API endpoint
    inventoryDT.ajax.reload();
    Swal.fire({ icon: 'success', title: 'Product deleted successfully' });
  } catch (error) {
    console.error('Failed to delete product:', error);
    Swal.fire({ icon: 'error', title: 'Failed to delete product' });
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
    document.getElementById('restockProductName').textContent = `${product.name || ('#' + productId)} (current: ${Number(product.stock || 0)})`;
    document.getElementById('restockQty').value = '';
    document.getElementById('restockDate').value = new Date().toISOString().slice(0,10);
    populateRestockSuppliersSelect();
    document.getElementById('restockModal').classList.remove('hidden');
  } catch (_e) {
    Swal.fire({ icon: 'error', title: 'Unable to open restock modal' });
  }
}

async function deleteProductImageFromTable(productId) {
  console.log('deleteProductImageFromTable called with productId:', productId);
  const { isConfirmed } = await Swal.fire({ icon: 'warning', title: 'Remove product image?', text: 'This will permanently delete the image file from the server.', showCancelButton: true, confirmButtonText: 'Remove' });
  if (!isConfirmed) return;
  
  try {
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}/image/base64`, {
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
    Swal.fire({ icon: 'success', title: 'Image removed', text: `Deleted file: ${result.deletedFile || 'unknown'}` });
  } catch (error) {
    console.error('Image deletion failed:', error);
    Swal.fire({ icon: 'error', title: 'Failed to remove image', text: String(error.message || '') });
  }
}

// Product modal functions
function openAddProductModal() {
  console.log('openAddProductModal called');
  editProductIndex = null;
  document.getElementById('productModalTitle').innerText = "Add Product";
  document.getElementById('prodName').value = '';
  document.getElementById('prodCategory').value = '';
  document.getElementById('prodDescription').value = '';
  document.getElementById('prodPrice').value = '';
  document.getElementById('prodStock').value = '';
  resetProductImage();
  const modal = document.getElementById('productModal');
  console.log('Product modal element:', modal);
  if (modal) {
    modal.classList.remove('hidden');
    console.log('Product modal should be visible now');
  } else {
    console.error('Product modal element not found');
  }
}

function editProduct(i) {
  editProductIndex = i;
  const p = products[i];
  document.getElementById('productModalTitle').innerText = "Edit Product";
  document.getElementById('prodName').value = p.name;
  document.getElementById('prodCategory').value = p.category;
  document.getElementById('prodDescription').value = p.description || '';
  document.getElementById('prodPrice').value = p.price;
  document.getElementById('prodStock').value = p.stock;
  
  // Load existing image if available
  if (p.image_url) {
    showProductImagePreview(p.image_url);
  } else {
    resetProductImage();
  }
  
  document.getElementById('productModal').classList.remove('hidden');
}

async function saveProduct() {
  const name = document.getElementById('prodName').value.trim();
  const category = document.getElementById('prodCategory').value.trim();
  const description = document.getElementById('prodDescription').value.trim();
  const price = parseFloat(document.getElementById('prodPrice').value) || 0;
  const stock = parseInt(document.getElementById('prodStock').value) || 0;
  const imageFile = document.getElementById('productImageInput').files[0];

  if (!name) { Swal.fire({ icon: 'warning', title: 'Product name required' }); return; }

  // Check if we're editing an existing product (server-side)
  const productId = document.getElementById('productModal').getAttribute('data-product-id');
  
  if (productId) {
    // Editing existing product
    try {
      const res = await apiFetch(`/products/${productId}`, { 
        method: 'PATCH', 
        body: JSON.stringify({ name, category, description, price, stock }) 
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
      
      // Refresh the table
      inventoryDT.ajax.reload();
      Swal.fire({ icon: 'success', title: 'Product updated successfully' });
    } catch (error) {
      console.error('Product update failed:', error);
      Swal.fire({ icon: 'error', title: 'Failed to update product' });
    }
  } else {
    // Adding new product
    try {
      // For new products, we'll add to local storage first
      // In a real app, you'd create the product via API first, then upload image
      products.push({ name, category, description, price, stock });
      localStorage.setItem('products', JSON.stringify(products));
      
      Swal.fire({ icon: 'success', title: 'Product added successfully' });
    } catch (error) {
      console.error('Product creation failed:', error);
      Swal.fire({ icon: 'error', title: 'Failed to create product' });
    }
  }
  
  closeProductModal();
  updateDashboard();
}

async function uploadProductImage(productId, imageFile) {
  // Convert file to base64
  const base64Data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(imageFile);
  });
  
  const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${productId}/image/base64`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('authToken')}`
    },
    body: JSON.stringify({
      productId,
      imageData: base64Data
    })
  });
  
  if (!response.ok) {
    throw new Error('Image upload failed');
  }
  
  const result = await response.json();
  
  // Update local product with new image URL
  const productIndex = products.findIndex(p => p.id === productId);
  if (productIndex !== -1) {
    products[productIndex].image_url = result.product.image_url;
    localStorage.setItem('products', JSON.stringify(products));
  }
  
  return result;
}

async function deleteProductImage(productIndex) {
  const product = products[productIndex];
  if (!product || !product.id) {
    Swal.fire({ icon: 'error', title: 'Product not found' });
    return;
  }
  
  if (!confirm('Remove image from this product? This will permanently delete the image file from the server.')) return;
  
  try {
    console.log(`Deleting image for product ${product.id} (${product.name})`);
    
    const response = await fetch(`${window.APP_CONFIG.API_BASE_URL}/products/${product.id}/image/base64`, {
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
    Swal.fire({ icon: 'success', title: 'Image removed', text: `Deleted file: ${result.deletedFile || 'unknown'}` });
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
  if (file.size > 5 * 1024 * 1024) {
    Swal.fire({ icon: 'warning', title: 'File size must be less than 5MB' });
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
// Cache bust: 2025-01-19 - Fixed timezone issue
function formatOrderDate(dateString) {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return 'Invalid Date';
    }
    
    // Use UTC methods to avoid timezone issues
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    
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
    const paymentCell = `${o.payment}${o.payment === 'GCash' && o.ref ? `<div class="text-xs text-blue-600">Ref: ${o.ref}</div>` : ''}`;
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
      statusIcon = '⏳';
    } else if (status === 'processing') {
      statusClass = 'bg-blue-100 text-blue-800 font-semibold';
      statusIcon = '🔄';
    } else if (status === 'completed') {
      statusClass = 'bg-green-100 text-green-800';
      statusIcon = '✅';
    } else if (status === 'cancelled') {
      statusClass = 'bg-red-100 text-red-800';
      statusIcon = '❌';
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
      `<span class="px-2 py-1 rounded text-xs ${statusClass}">${statusIcon} ${o.status || '-'}</span>`,
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
        // Handle nested product_id object structure
        const name = it.product_name || (it.product_id && it.product_id.name) || it.name || ('#' + (it.product_id && it.product_id._id || it.product_id));
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || (it.product_id && it.product_id.price) || it.price || 0);
        const total = Number(it.total_price || (qty * price));
        return `<tr>
          <td class="px-3 py-2">${name}</td>
          <td class="px-3 py-2 text-right">${qty}</td>
          <td class="px-3 py-2 text-right">₱${price.toFixed(2)}</td>
          <td class="px-3 py-2 text-right">₱${total.toFixed(2)}</td>
        </tr>`;
      }).join('');
      document.getElementById('reviewItems').innerHTML = rows || '<tr><td class="px-3 py-2" colspan="4">No items</td></tr>';
    } catch (_e) {
      const rows = (o.items || []).map(it => {
        // Handle nested product_id object structure
        const name = it.product_name || (it.product_id && it.product_id.name) || it.name || ('#' + (it.product_id && it.product_id._id || it.product_id));
        const qty = Number(it.quantity || 0);
        const price = Number(it.unit_price || (it.product_id && it.product_id.price) || it.price || 0);
        const total = Number(it.total_price || (qty * price));
        return `<tr>
          <td class="px-3 py-2">${name}</td>
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

function saveOrder() {
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
  saveToBackend();
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
  // Create a simple item selection dialog
  const productName = prompt('Enter product name:');
  if (!productName) return;
  
  const quantity = prompt('Enter quantity:', '1');
  if (!quantity || isNaN(quantity) || quantity <= 0) {
    Swal.fire({ icon: 'warning', title: 'Invalid quantity' });
    return;
  }
  
  const price = prompt('Enter unit price:', '0.00');
  if (!price || isNaN(price) || price < 0) {
    Swal.fire({ icon: 'warning', title: 'Invalid price' });
    return;
  }
  
  const item = {
    id: Date.now(), // Simple ID for tracking
    product_name: productName,
    quantity: parseInt(quantity),
    unit_price: parseFloat(price),
    total_price: parseInt(quantity) * parseFloat(price)
  };
  
  orderItems.push(item);
  updateOrderItemsDisplay();
  updateOrderTotal();
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
  if (payment === 'GCash') {
    refInput.classList.remove('hidden');
  } else {
    refInput.classList.add('hidden');
    refInput.value = '';
  }
}

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
  document.getElementById('restockProductName').textContent = `${p.name} (current: ${p.stock})`;
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
}

function confirmRestock() {
  const supplierIndex = document.getElementById('restockSupplier').value;
  const qty = parseInt(document.getElementById('restockQty').value) || 0;
  const date = document.getElementById('restockDate').value || new Date().toISOString().slice(0,10);

  if (restockProductIndex === null && restockProductIdDirect === null) { Swal.fire({ icon: 'warning', title: 'Product not selected' }); return; }
  if (!qty || qty <= 0) { Swal.fire({ icon: 'warning', title: 'Enter a valid quantity' }); return; }
  if (supplierIndex === '') { Swal.fire({ icon: 'warning', title: 'Select a supplier' }); return; }

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
      apiFetch(`/suppliers/${supplierId}/restock`, { method: 'POST', body: JSON.stringify({ productId, qty, date }) })
        .then(() => refreshInventoryOnly())
        .catch(()=>{});
    }
  } catch (_e) {}

  closeRestockModal();
  renderInventory();
  renderSuppliers();
  updateDashboard();
  Swal.fire({ icon: 'success', title: 'Restocked', text: `${qty} × ${prodName} from ${suppliers[supplierIndex].name}` });
}

// --------------------------- LOW STOCK ALERTS ---------------------------
function computeLowStock() {
  return products.filter(p => Number(p.stock || 0) < getLowStockThreshold(p));
}

function toggleLowStockModal() {
  console.log('toggleLowStockModal called');
  const modal = document.getElementById('lowStockModal');
  console.log('Low stock modal element:', modal);
  if (modal) {
    if (modal.classList.contains('hidden')) {
      // open and populate
      renderLowStockModalList(showAllLowStockInModal);
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

function renderLowStockModalList(showAll) {
  const low = computeLowStock();
  const list = document.getElementById('lowStockModalList');
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
  document.getElementById('receiptTotal').textContent = order.total.toFixed(2);
  document.getElementById('receiptDiscount').textContent = order.discount.toFixed(2);
  document.getElementById('receiptNetTotal').textContent = order.netTotal.toFixed(2);
  // Load items into receipt table
  (async () => {
    try {
      let items = [];
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
      const rows = items.map(it => {
        const name = it.name || ('#' + it.product_id);
        const qty = Number(it.quantity || 0);
        const price = Number(it.price || 0);
        const total = qty * price;
        return `<tr>
          <td class="px-3 py-2">${name}</td>
          <td class="px-3 py-2 text-right">${qty}</td>
          <td class="px-3 py-2 text-right">₱${price.toFixed(2)}</td>
          <td class="px-3 py-2 text-right">₱${total.toFixed(2)}</td>
        </tr>`;
      }).join('');
      document.getElementById('receiptItems').innerHTML = rows || '<tr><td class="px-3 py-2" colspan="4">No items</td></tr>';
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
    const limited = lowStockItems.slice(0, DASHBOARD_LOW_STOCK_LIMIT);
    const extraCount = Math.max(lowStockItems.length - DASHBOARD_LOW_STOCK_LIMIT, 0);
    const itemsHtml = limited.map(item => {
      const actualStock = Math.max(0, item.stock || 0); // Ensure stock is never negative
      const stockText = actualStock === 0 ? 'Out of Stock' : `${actualStock} left`;
      const stockColor = actualStock === 0 ? 'text-red-600' : 'text-yellow-600';
      return `<li class="flex justify-between items-center">
        <span>${item.name} <span class="${stockColor}">(${stockText})</span></span>
        <button class="text-indigo-600 ml-2" onclick="openRestockModalFromLowStock(${item.id})">Receive</button>
      </li>`;
    }).join('');
    const extraHtml = extraCount > 0 ? `<li class="mt-2 text-sm text-gray-600">and ${extraCount} more… <button class="text-blue-600" onclick="loadAllLowStockItems()">Show 5 more</button></li>` : '';
    lowStockList.innerHTML = itemsHtml + extraHtml;
  } else {
    lowStockList.innerHTML = '<li>No low stock items</li>';
  }

  // simple chart: weekly sample (placeholder)
  // try to load real data; fallback to placeholder if fails
  loadSalesOverview();
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
document.getElementById('currentDate').textContent = new Date().toLocaleDateString();
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
  if (!res.ok) throw new Error('API error');
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
    orders = (ordersRes.orders || []).map(o => ({ id: o.id, displayId: o.order_code || `ORD${o.id}`, customer: o.name, contact: o.contact, address: o.address, total: Number(o.totalPrice || 0), discount: Number(o.discount || 0), netTotal: Number(o.net_total || 0), status: o.status, type: o.type, payment: o.payment, ref: o.ref, createdAt: o.createdAt }));

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
      const limited = lowStockRes.products.slice(0, DASHBOARD_LOW_STOCK_LIMIT);
      const extraCount = Math.max(lowStockRes.products.length - DASHBOARD_LOW_STOCK_LIMIT, 0);
      const itemsHtml = limited.map(item => {
        const actualStock = Math.max(0, item.stock || 0); // Ensure stock is never negative
        const stockText = actualStock === 0 ? 'Out of Stock' : `${actualStock} left`;
        const stockColor = actualStock === 0 ? 'text-red-600' : 'text-yellow-600';
        return `<li class="flex justify-between items-center">
          <span>${item.name} <span class="${stockColor}">(${stockText})</span></span>
          <button class="text-indigo-600 ml-2" onclick="openRestockModalFromLowStock(${item.id})">Receive</button>
        </li>`;
      }).join('');
      const extraHtml = extraCount > 0 ? `<li class="mt-2 text-sm text-gray-600">and ${extraCount} more… <button class="text-blue-600" onclick="loadAllLowStockItems()">Show 5 more</button></li>` : '';
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
  orders = (ordersRes.orders || []).map(o => ({ id: o.id, displayId: o.order_code || `ORD${o.id}`, customer: o.name, contact: o.contact, address: o.address, total: Number(o.totalPrice || 0), discount: Number(o.discount || 0), netTotal: Number(o.net_total || 0), status: o.status, type: o.type, payment: o.payment, ref: o.ref, createdAt: o.createdAt }));
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

// --------------------------- DATE FILTER UI HANDLERS ---------------------------
function onDateFilterChange(value) {
  activeDateFilter = value || null;
  // Update the header date label to reflect filter or today
  if (activeDateFilter) {
    const [y, m, d] = activeDateFilter.split('-').map(Number);
    const display = new Date(y, m - 1, d).toLocaleDateString();
    document.getElementById('currentDate').textContent = display + ' (filtered)';
  } else {
    document.getElementById('currentDate').textContent = new Date().toLocaleDateString();
  }
  renderOrders();
  updateDashboard();
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


