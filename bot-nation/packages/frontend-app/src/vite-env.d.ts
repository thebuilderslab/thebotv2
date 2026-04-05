/// <reference types="vite/client" />

// Treat CSS imports as side-effect modules
declare module "*.css" {
  const _: string;
  export default _;
}
