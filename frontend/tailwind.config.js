/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0e0e12",
        panel: "#17171f",
        line: "#2a2a36",
      },
    },
  },
  plugins: [],
};
