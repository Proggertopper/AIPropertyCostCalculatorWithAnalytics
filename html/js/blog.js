// Scroll to top functionality
const scrollBtn = document.getElementById('scrollTop');
window.addEventListener('scroll', () => {
    scrollBtn.classList.toggle('visible', window.scrollY > 300);
});
scrollBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Filter chips
document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
    });
});

// Pagination
document.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.textContent !== '...') {
            document.querySelectorAll('.page-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
});

// Load more
document.querySelector('.load-btn').addEventListener('click', () => {
    alert('Loading more articles...');
});