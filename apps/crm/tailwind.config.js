/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        lavender: '#EDEAF8',
        parchment: '#F0EDE6',
        purple: {
          DEFAULT: '#5B21B6',
          50:  '#F3F0FD',
          100: '#E8E2FB',
          200: '#CFC3F7',
          300: '#B09EF2',
          400: '#8B6FEA',
          500: '#6D40DF',
          600: '#5B21B6',
          700: '#4A1A94',
          800: '#381470',
          900: '#260D4D',
        },
        gold: {
          DEFAULT: '#F5C518',
          light: '#FDE97A',
          dark: '#C99A0A',
        },
        brand: {
          green: '#27AE60',
          red: '#C0392B',
          wa: '#25D366',
        },
      },
      fontFamily: {
        heading: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['Outfit', '"Noto Sans Tamil"', 'Inter', 'sans-serif'],
      },
      borderRadius: {
        card: '18px',
        pill: '50px',
      },
      boxShadow: {
        card: '0 4px 24px rgba(91,33,182,0.08), 0 0 30px 6px rgba(139,92,246,0.30)',
        'card-hover': '0 8px 40px rgba(91,33,182,0.18), 0 0 40px 10px rgba(139,92,246,0.40)',
        gold: '0 4px 24px rgba(245,197,24,0.25)',
        glass: '0 8px 32px rgba(91,33,182,0.12), 0 0 30px 6px rgba(139,92,246,0.30)',
      },
      backgroundImage: {
        'purple-radial': 'radial-gradient(ellipse at top right, rgba(245,197,24,0.15) 0%, transparent 60%), radial-gradient(ellipse at bottom left, rgba(176,158,242,0.25) 0%, transparent 60%)',
        'glass-gradient': 'linear-gradient(135deg, rgba(255,255,255,0.85) 0%, rgba(237,234,248,0.7) 100%)',
      },
      backdropBlur: {
        glass: '28px',
      },
    },
  },
  plugins: [],
};
