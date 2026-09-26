/** @type {import('tailwindcss').Config} */
module.exports = {
  // Only PawShop.html links assets/tailwind.css. Scanning every *.html file made
  // Tailwind read ordinary prose in the content pages and emit phantom utilities
  // from it (the word "static" in privacy.html produced .static), which churned
  // the committed stylesheet. product.html is now a redirect shim and no longer
  // links tailwind.css. Keep this list in sync with the pages that actually link
  // assets/tailwind.css.
  content: ['./PawShop.html'],
  theme: { extend: {} },
  plugins: [],
};
