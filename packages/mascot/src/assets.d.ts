// The apps get this from vite/client; the package's own typecheck needs it too.
declare module "*.png" {
  const src: string;
  export default src;
}
