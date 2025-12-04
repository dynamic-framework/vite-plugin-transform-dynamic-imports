# Plugin de Imports Dinámicos para Vite

Plugin de Vite/Rollup que transforma imports dinámicos y estáticos en los chunks generados para usar una base de ruta configurable en tiempo de ejecución. Útil cuando los assets de un widget se sirven bajo URLs por widget y los chunks deben resolverse en tiempo de ejecución (por ejemplo, window['resourceBasePath-{{widget.wid}}']).

Características:
- Reescribe import("./file.chunk.js") en los entry chunks para anteponer una base de ruta en tiempo de ejecución.
- Reescribe `from "./main.js"` dentro de archivos chunk a una URL con plantilla para entrega vía widget manager.
- Acceso SSR-seguro a window usando guards con typeof.
- Regeneración opcional de source maps vía MagicString.
- Totalmente configurable mediante opciones.

## Instalación

Instala como dependencia de desarrollo junto a Vite:

```bash
npm install -D @dynamic-framework/dynamic-imports-vite-plugin
```

Peer dependency: vite ^7.2.6

## Inicio Rápido

Agrega el plugin a tu vite.config:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import transformDynamicImports from '@dynamic-framework/dynamic-imports-vite-plugin';

export default defineConfig({
  build: {
    // Asegura que se generen chunks con code-splitting
    rollupOptions: {
      // Tus inputs/outputs como de costumbre
    },
  },
  plugins: [
    transformDynamicImports({
      // configuraciones opcionales abajo
    }),
  ],
});
```

## Cómo funciona

Durante generateBundle, el plugin escanea los chunks construidos y aplica dos transformaciones:
1) Entry chunks: `import("./file.chunk.js")` -> `import(((typeof window !== 'undefined' && window) ? window['resourceBasePath-{{widget.wid}}'] : '') + "file.chunk.js")`.
2) Archivos chunk: `from "./main.js"` -> `from "{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js"`.

Ambos patrones respetan comillas simples, dobles o backticks y espacios en blanco. La detección de entry por defecto usa `chunk.isEntry` de Rollup.

## Opciones

```ts
transformDynamicImports({
  // Construye el accessor en window para la base de ruta en tiempo de ejecución usando el placeholder del widget
  resourceBaseVar: (widPlaceholder) => `window['resourceBasePath-${widPlaceholder}']`,

  // Predicado para determinar si un chunk se trata como entry (por defecto: chunk.isEntry)
  entryNamePredicate: (chunk) => chunk.isEntry ?? false,

  // Regenerar source maps para chunks transformados
  enableSourceMap: false,

  // Placeholder insertado en resourceBaseVar
  widgetPlaceholder: '{{widget.wid}}',

  // Patrón para coincidir con archivos chunk (usado para detectar imports dinámicos)
  chunkFilePattern: '.chunk.js',

  // Nombre del archivo de entrada referido por imports estáticos dentro de los chunks
  entryFileName: 'main.js',

  // Plantilla de URL para reemplazar imports estáticos de main.js dentro de archivos chunk
  staticImportUrlTemplate: '{{site.url}}/widget_manager/{{widget.wid}}/{{widget.version}}.js',
});
```

## Ejemplo Sencillo

Supón que tu app produce un entry chunk que contiene:

```js
// en entry chunk
import('./users.chunk.js');
```

En tiempo de ejecución, define una base de ruta global (por ejemplo, por widget):

```html
<script>
  window['resourceBasePath-{{widget.wid}}'] = 'https://cdn.example.com/widgets/123/';
</script>
```

El plugin convierte el import en:

```js
import(((typeof window !== 'undefined' && window) ? window['resourceBasePath-{{widget.wid}}'] : '') + 'users.chunk.js');
```

## Casos Prácticos

- Widgets multi-tenant: Servir chunks desde bases de URL específicas por tenant o versión de widget.
- Widgets entregados por CMS: El archivo principal se resuelve vía `{{site.url}}/widget_manager/...` mientras los chunks se cargan desde la base en tiempo de ejecución.
- Builds compatibles con SSR: El plugin envuelve el acceso a `window` con un guard de typeof para evitar crashes en SSR.

## Requisitos y Consideraciones

- Code-splitting: Asegura que Vite/Rollup generen archivos chunk (por ejemplo, que existan imports dinámicos y que `chunkFilePattern` coincida con tu nomenclatura de chunks).
- Nomenclatura de chunks: El matcher por defecto espera nombres que terminen en `.chunk.js`. Si tu output difiere (por ejemplo, `-abc123.js`), ajusta `chunkFilePattern`.
- Detección de entry: Por defecto usa `chunk.isEntry`. Si tu build produce múltiples entradas o entradas no estándar, provee `entryNamePredicate`.
- Variable global: Debes establecer la variable de base de ruta en tiempo de ejecución antes de que el entry chunk ejecute. Por defecto: `window['resourceBasePath-{{widget.wid}}']`.
- Reescritura de imports estáticos: Solo afecta archivos chunk que contengan `from "./main.js"`. Si el nombre o la ruta de tu archivo principal difiere, actualiza `entryFileName`.
- Seguridad: Si la base global puede ser influenciada por usuarios, considera sanitización, normalización de rutas y CSP para prevenir traversal/injection. El plugin incluye un TODO para endurecer esto.
- Source maps: Configura `enableSourceMap: true` si necesitas mapas tras la transformación.
- SSR: La transformación usa `typeof window !== 'undefined'` para evitar errores; en server-side prefijará con string vacío, por lo que la ruta del chunk dinámico queda solo con el nombre del archivo.

## Pruebas

Ejecuta los tests (si existen):

```bash
npm run test
```

## Build

```bash
npm run build
```

Esto genera el plugin transformado en `dist/` con types.

## Licencia

MIT
