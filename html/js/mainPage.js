if (window.location.hash && window.location.hash === "#_=_") {
    // Убираем hash, чтобы не было в адресной строке
    history.replaceState(null, null, window.location.href.split('#')[0]);
}

