/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        lavender: '#EDEAF8',
        purple: {
          DEFAULT: '#5B21B6',
          600: '#5B21B6',
          700: '#4A1A94',
          800: '#381470',
          900: '#3B0764',
        },
      },
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
