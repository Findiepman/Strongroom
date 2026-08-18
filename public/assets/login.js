'use strict';

const form = document.getElementById('login-form');
const errorLine = document.getElementById('login-error');
const btn = document.getElementById('login-btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorLine.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in';
  try {
    await API.call('/api/auth/login', {
      method: 'POST',
      body: {
        username: form.username.value.trim(),
        password: form.password.value,
      },
    });
    window.location.href = '/files';
  } catch (err) {
    errorLine.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Sign in';
    form.password.focus();
    form.password.select();
  }
});
