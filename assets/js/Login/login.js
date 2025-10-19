document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('loginError');
  errorEl.classList.add('hidden');

  try {
    const res = await fetch(`${window.APP_CONFIG.API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!res.ok) throw new Error('Login failed');
    const data = await res.json();
    localStorage.setItem('authToken', data.token);
    localStorage.setItem('authUser', JSON.stringify(data.user));
    window.location.href = './pages/dashboard.html';
  } catch (_err) {
    errorEl.textContent = 'Invalid credentials';
    errorEl.classList.remove('hidden');
  }
});

// seed removed: use existing DB account


