// Runs before first paint: lets the hero entrance and the scroll moments start hidden-safe (see kit/motion, kit/moments).
document.documentElement.classList.add('m-enter','mo-js');
setTimeout(()=>document.documentElement.classList.add('m-enter-done'),700);
setTimeout(()=>document.documentElement.classList.add('mo-safe'),2500);
