element.textContent = untrusted;
element.setAttribute("href", "https://example.invalid");
const value = element.innerHTML;
