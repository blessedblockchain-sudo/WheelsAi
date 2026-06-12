import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Dark theme base colors
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",

        // Matrix color palette
        matrix: {
          green: "#00ff00",
          "green-dim": "#00cc00",
          cyan: "#00d4ff",
          purple: "#a855f7",
          dark: "#0a0a0f",
          surface: "#12121a",
          border: "#1e1e2e",
        },

        // Navy palette
        navy: {
          950: "#040a18",
          900: "#0a1628",
          800: "#0f1d35",
          700: "#1a2744",
          600: "#243352",
          500: "#2e4068",
          400: "#3b82f6",
          300: "#60a5fa",
          200: "#93c5fd",
        },

        // Neutral gray remapped to a blue-tinted ramp so the dashboard's
        // hardcoded gray-*/dark:gray-* chrome (≈59 files) follows the
        // homepage navy identity with no per-file edits. Light end = slate
        // (legible cool neutrals); dark end = the navy surfaces so
        // dark:bg-gray-900 → navy-900 cards, dark:bg-gray-950 → navy-950 bg.
        gray: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#1a2744",
          800: "#0f1d35",
          900: "#0a1628",
          950: "#040a18",
        },

        // Primary = the homepage blue (#3b82f6 at 500). Replaces the old
        // matrix-green scale — `*-primary-NNN` is used ~250x across the
        // dashboard, so this single change reskins those actions to blue.
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
          950: "#172554",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
          50: "#fdf4ff",
          100: "#fae8ff",
          200: "#f5d0fe",
          300: "#f0abfc",
          400: "#e879f9",
          500: "#d946ef",
          600: "#c026d3",
          700: "#a21caf",
          800: "#86198f",
          900: "#701a75",
          950: "#4a044e",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "matrix-fall": "matrix-fall 10s linear infinite",
        "wheel-spin": "wheel-spin 20s linear infinite",
        "wheel-spin-reverse": "wheel-spin-reverse 15s linear infinite",
        "wheel-spin-slow": "wheel-spin 30s linear infinite",
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
        float: "float 3s ease-in-out infinite",
        glitch: "glitch 5s ease-in-out infinite",
        "fade-in-up": "fade-in-up 0.6s ease-out forwards",
        "pulse-ring": "pulse-ring 2s ease-out infinite",
        orbit: "orbit var(--orbit-duration, 10s) linear infinite",
        typewriter: "typewriter 2s steps(40) forwards",
        blink: "blink 1s step-end infinite",
      },
      keyframes: {
        "matrix-fall": {
          "0%": { transform: "translateY(-100%)", opacity: "1" },
          "100%": { transform: "translateY(100vh)", opacity: "0.3" },
        },
        "wheel-spin": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "wheel-spin-reverse": {
          "0%": { transform: "rotate(360deg)" },
          "100%": { transform: "rotate(0deg)" },
        },
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 20px rgba(0, 255, 0, 0.3)" },
          "50%": { boxShadow: "0 0 40px rgba(0, 255, 0, 0.6)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-10px)" },
        },
        glitch: {
          "0%, 90%, 100%": { transform: "translate(0)", opacity: "1" },
          "92%": { transform: "translate(-2px, 1px)", opacity: "0.8" },
          "94%": { transform: "translate(2px, -1px)", opacity: "0.9" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(30px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.8)", opacity: "0.8" },
          "50%": { transform: "scale(1)", opacity: "0.4" },
          "100%": { transform: "scale(1.2)", opacity: "0" },
        },
        orbit: {
          "0%": { transform: "rotate(0deg) translateX(var(--orbit-radius, 100px)) rotate(0deg)" },
          "100%": { transform: "rotate(360deg) translateX(var(--orbit-radius, 100px)) rotate(-360deg)" },
        },
        typewriter: {
          from: { width: "0" },
          to: { width: "100%" },
        },
        blink: {
          "0%, 50%": { opacity: "1" },
          "51%, 100%": { opacity: "0" },
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "grid-pattern": `
          linear-gradient(rgba(0, 255, 0, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(0, 255, 0, 0.03) 1px, transparent 1px)
        `,
      },
      boxShadow: {
        glow: "0 0 20px rgba(0, 255, 0, 0.4), 0 0 40px rgba(0, 255, 0, 0.2)",
        "glow-lg": "0 0 30px rgba(0, 255, 0, 0.6), 0 0 60px rgba(0, 255, 0, 0.4)",
        "glow-cyan": "0 0 20px rgba(0, 212, 255, 0.4), 0 0 40px rgba(0, 212, 255, 0.2)",
        "glow-purple": "0 0 20px rgba(168, 85, 247, 0.4), 0 0 40px rgba(168, 85, 247, 0.2)",
        "glow-navy": "0 0 20px rgba(59, 130, 246, 0.4), 0 0 40px rgba(59, 130, 246, 0.2)",
        "glow-navy-lg": "0 0 30px rgba(59, 130, 246, 0.5), 0 0 60px rgba(59, 130, 246, 0.3)",
      },
    },
  },
  plugins: [require("@tailwindcss/forms")],
};

export default config;
