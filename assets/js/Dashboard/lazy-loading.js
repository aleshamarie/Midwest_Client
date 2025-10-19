// --------------------------- LAZY LOADING ---------------------------
function lazyLoadImages() {
  const lazyImages = document.querySelectorAll('.lazy-image');
  
  if ('IntersectionObserver' in window) {
    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.classList.remove('lazy-image');
            img.classList.add('loaded');
            observer.unobserve(img);
          }
        }
      });
    }, {
      rootMargin: '50px 0px', // Start loading 50px before image comes into view
      threshold: 0.1
    });

    lazyImages.forEach(img => {
      imageObserver.observe(img);
    });
  } else {
    // Fallback for browsers without IntersectionObserver
    lazyImages.forEach(img => {
      if (img.dataset.src) {
        img.src = img.dataset.src;
        img.classList.remove('lazy-image');
        img.classList.add('loaded');
      }
    });
  }
}

// Initialize lazy loading when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  // Add CSS for loading animation and better UX
  const style = document.createElement('style');
  style.textContent = `
    .lazy-image {
      background: linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 50%, #f3f4f6 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 0.375rem;
      position: relative;
      overflow: hidden;
    }
    
    .lazy-image::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
      animation: sweep 2s infinite;
    }
    
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    
    @keyframes sweep {
      0% { left: -100%; }
      100% { left: 100%; }
    }
    
    .lazy-image.loading {
      animation: pulse 1s infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 0.8; }
    }
    
    .lazy-image.loaded {
      animation: none;
      background: none;
      opacity: 1;
      transition: opacity 0.3s ease-in-out;
    }
    
    .lazy-image.fallback {
      filter: grayscale(20%);
      opacity: 0.8;
    }
    
    .lazy-image.fallback::after {
      content: '⚠️';
      position: absolute;
      top: 2px;
      right: 2px;
      font-size: 10px;
      background: rgba(0,0,0,0.7);
      color: white;
      border-radius: 50%;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  `;
  document.head.appendChild(style);
});

// --------------------------- PROGRESSIVE LOADING ---------------------------
async function loadMoreProductsIfNeeded() {
  if (window.isLoadingProducts || window.allProductsLoaded) return;
  
  const inventoryDT = window.inventoryDT;
  if (!inventoryDT) return;
  
  const currentPage = inventoryDT.page.info().page + 1;
  const totalPages = inventoryDT.page.info().pages;
  
  // Load more products when user is near the end of current data
  if (currentPage >= totalPages - 1 && window.currentProductPage < window.totalProductPages) {
    await loadMoreProducts();
  }
}

async function loadMoreProducts() {
  if (window.isLoadingProducts || window.allProductsLoaded) return;
  
  window.isLoadingProducts = true;
  
  // Show loading state on button
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
    loadMoreBtn.querySelector('.loading-spinner').classList.remove('hidden');
    loadMoreBtn.querySelector('.btn-text').textContent = 'Loading...';
  }
  
  try {
    window.currentProductPage++;
    const response = await window.apiFetch(`/products?page=${window.currentProductPage}&pageSize=25`);
    
    if (response.products && response.products.length > 0) {
      const newProducts = response.products.map(p => ({
        id: p.id,
        handle: p.handle,
        sku: p.sku,
        name: p.name,
        category: p.category,
        description: p.description,
        price: Number(p.price || 0),
        stock: Number(p.stock || 0),
        lowStockThreshold: Number(p.low_stock_threshold || 5),
        available: Boolean(p.available_for_sale),
        image_url: p.image_url || null
      }));
      
      // Add new products to existing array
      window.products = [...window.products, ...newProducts];
      localStorage.setItem('products', JSON.stringify(window.products));
      
      // Update DataTable
      const inventoryDT = window.inventoryDT;
      if (inventoryDT) {
        inventoryDT.clear();
        window.products.forEach((p, i) => {
          const rowClass = Number(p.stock || 0) < (window.getLowStockThreshold ? window.getLowStockThreshold(p) : 5) ? 'bg-red-50' : '';
          // Use base64 image URLs directly
          const imageHtml = p.image_url 
            ? `<img src="${p.image_url}" alt="${p.name}" class="w-12 h-12 object-cover rounded" onerror="this.src='../assets/images/Midwest.jpg'">`
            : `<img src="../assets/images/Midwest.jpg" alt="Midwest Grocery" class="w-12 h-12 object-cover rounded">`;
          
          inventoryDT.row.add([
            imageHtml,
            p.name,
            p.category,
            p.description || 'No description',
            `₱${(p.price || 0).toFixed(2)}`,
            String(p.stock ?? 0),
            `<button onclick="editProduct(${i})" class="text-blue-600">Edit</button>
             <button onclick="deleteProduct(${i})" class="text-red-600 ml-2">Delete</button>
             <button onclick="openRestockModal(${i})" class="text-indigo-600 ml-2">Restock</button>
             ${p.image_url ? `<button onclick="deleteProductImage(${i})" class="text-orange-600 ml-2" title="Remove image from server">Remove Image</button>` : ''}`
          ]).node().className = rowClass;
        });
        
        inventoryDT.draw(false);
        lazyLoadImages();
        
        // Update pagination info
        window.totalProductPages = response.pagination?.totalPages || 1;
        if (window.currentProductPage >= window.totalProductPages) {
          window.allProductsLoaded = true;
        }
      }
    } else {
      window.allProductsLoaded = true;
    }
  } catch (error) {
    console.error('Failed to load more products:', error);
  } finally {
    window.isLoadingProducts = false;
    
    // Reset button state
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.querySelector('.loading-spinner').classList.add('hidden');
      loadMoreBtn.querySelector('.btn-text').textContent = 'Load More';
      
      // Hide button if all products loaded
      if (window.allProductsLoaded) {
        loadMoreBtn.classList.add('hidden');
      }
    }
  }
}

// Load more products when user scrolls to bottom
function setupInfiniteScroll() {
  const tableContainer = document.querySelector('#inventoryTable_wrapper .dataTables_scrollBody');
  if (tableContainer) {
    tableContainer.addEventListener('scroll', function() {
      const { scrollTop, scrollHeight, clientHeight } = this;
      if (scrollTop + clientHeight >= scrollHeight - 100) {
        loadMoreProductsIfNeeded();
      }
    });
  }
}

// Update Load More button visibility
function updateLoadMoreButton() {
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    if (window.allProductsLoaded || window.currentProductPage >= window.totalProductPages) {
      loadMoreBtn.classList.add('hidden');
    } else {
      loadMoreBtn.classList.remove('hidden');
    }
  }
}

// Export for use in other scripts
window.lazyLoadImages = lazyLoadImages;
window.loadMoreProductsIfNeeded = loadMoreProductsIfNeeded;
window.loadMoreProducts = loadMoreProducts;
window.setupInfiniteScroll = setupInfiniteScroll;
window.updateLoadMoreButton = updateLoadMoreButton;
