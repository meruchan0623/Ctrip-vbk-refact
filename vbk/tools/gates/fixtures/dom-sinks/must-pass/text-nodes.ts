export function f(el: HTMLElement, s: string) {
  el.textContent = s;
  el.append(document.createTextNode(s));
  el.setAttribute('href', 'https://example.com');
}
