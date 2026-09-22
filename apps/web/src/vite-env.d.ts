/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 接口基址，默认 /api（同源部署，由 vite proxy 或 nginx 转发） */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** CSS Module 的类型声明：让 `import styles from './x.module.css'` 具备类型 */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
