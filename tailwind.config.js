/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./App.jsx", "./main.jsx", "./components/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        emerald: {
          950: "#06120e",
        },
      },
    },
  },
  plugins: [],
}
