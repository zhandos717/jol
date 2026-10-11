const STAR = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4L2.8 9.5l6.4-.8z"/></svg>';
const fmtRating = r => `<span class="rating">★ ${Number(r ?? 5).toFixed(1)}</span>`;

function ratingWidget(container, { title, good, bad, onSubmit }) {
  let stars = 0;
  const picked = new Set();
  container.innerHTML = `<div class="rate-box"><b>${title}</b>
    <div class="stars">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" aria-label="${n}">${STAR}</button>`).join('')}</div>
    <div class="tags"></div><button class="cta go" disabled style="opacity:.4">Оценить</button></div>`;
  const tagsEl = container.querySelector('.tags'), submit = container.querySelector('.cta');
  container.querySelectorAll('.stars button').forEach(b => b.onclick = () => {
    stars = +b.dataset.n;
    picked.clear();
    container.querySelectorAll('.stars button').forEach(x => x.classList.toggle('on', +x.dataset.n <= stars));
    tagsEl.innerHTML = (stars >= 4 ? good : bad).map(t => `<button>${t}</button>`).join('');
    tagsEl.querySelectorAll('button').forEach(t => t.onclick = () => {
      picked.has(t.textContent) ? picked.delete(t.textContent) : picked.add(t.textContent);
      t.classList.toggle('on');
    });
    submit.disabled = false;
    submit.style.opacity = 1;
  });
  submit.onclick = async () => {
    submit.disabled = true;
    try {
      await onSubmit(stars, [...picked]);
      container.innerHTML = '<div class="rate-box"><b>Спасибо за оценку!</b></div>';
    } catch (e) {
      submit.disabled = false;
      alert(e.message);
    }
  };
}
