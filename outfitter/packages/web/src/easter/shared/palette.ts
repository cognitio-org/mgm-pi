// The games' shared 16-colour palette: the Commodore 64's sixteen slots (black, white, red, cyan,
// purple, green, blue, yellow, orange, brown, light red, three greys, light green, light blue),
// each nudged brighter/more saturated so they sit next to the app's own C64 dark theme tokens
// (theme.css's --bg #302870, --ok #5cff8a, --warn #f4cf3c, --danger #ff8a8a, --border #8b7cd8)
// instead of looking muddy beside them. Every sprite palette in rescue/ and dreadnought/ picks from
// this table, never an ad-hoc hex, so the two games read as one machine's output.

export const C = {
  black: "#000000",
  white: "#ffffff",
  red: "#b8423a",
  cyan: "#7fd8e6",
  purple: "#9048b0",
  green: "#3fa34d",
  blue: "#352879",
  yellow: "#f4cf3c",
  orange: "#f07b20",
  brown: "#6b4a16",
  lightRed: "#ff8a8a",
  darkGrey: "#444444",
  grey: "#6c6c6c",
  lightGreen: "#5cff8a",
  lightBlue: "#8b7cd8",
  lightGrey: "#a8a8a8",
  // Not extra palette slots: the theme's darkest blues (night sky, UI panels) so the canvas sits
  // seamlessly inside the dark-theme frame, plus a white-hot fire core.
  night: "#1c1650",
  ink: "#241e5c",
  bg: "#302870",
  paper: "#e4e0fb",
  hot: "#fff6cf",
} as const;
