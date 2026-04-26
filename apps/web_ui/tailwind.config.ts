import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f2f9f4",
          100: "#daf0e1",
          200: "#afe1c3",
          300: "#7ecda0",
          400: "#4fb880",
          500: "#33a26a",
          600: "#248255",
          700: "#1d6544",
          800: "#174d34",
          900: "#113424"
        }
      }
    }
  },
  plugins: []
};

export default config;
