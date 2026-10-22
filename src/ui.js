/** 轻量 UI 辅助：底部提示条。 */

let hideTimer = 0;

export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}
