export const f = (s: string) => {
  const el = document.createElement("script");
  el.text = s;
  document.head.append(el);
};
