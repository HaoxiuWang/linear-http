# Linear HTTP 🚀

**Linear** is a high-performance, zero-dependency Node.js web framework designed for microservices and scalable architectures.

It combines the **speed of a Radix Tree Router** ($O(k)$ lookup) with the **architectural elegance of Fastify's Encapsulation model**. It allows you to build complex systems where plugins, middlewares, and decorators remain isolated where needed, yet shared where appropriate.

## ✨ Features

- **🚀 High Performance**: Custom Radix Tree router implementation.
- **📦 Encapsulation**: Plugins create new isolated scopes (child instances).
- **🛡️ Middleware Inheritance**: Middlewares follow the scope chain (Copy-on-Write).
- **🪝 Full Lifecycle Hooks**: `onRequest`, `preHandler`, `onSend`, `onError`, etc.
- **⚡ Zero Dependencies**: Built using only native Node.js modules (`http`, `url`, `querystring`).
- **🔌 TypeScript Ready**: Ships with built-in type definitions.

## 📦 Installation

```bash
npm install linear-http
```

## ⚡ Quick Start

```js
import linear from 'linear-http';

const app = linear();

// Basic Route
app.get('/', (ctx) => {
  ctx.send({ hello: 'world' });
});

// Route with Params
app.get('/users/:id', (ctx) => {
  ctx.json({ id: ctx.params.id });
});

app.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
```

## 🏗️ Architecture: Encapsulation

Linear uses a hierarchical plugin system. When you register a plugin, it creates a Child Scope.
- **Inheritance:** Children inherit decorators and configuration from parents.
- **Isolation:** Middlewares and decorators defined in a child do not leak to the parent or siblings.

**Example: Isolation**

```js
import linear, { fp } from 'linear-http';

const app = linear();

// 1. Global Plugin (using fp helper to break encapsulation)
app.register(fp(async (instance) => {
  instance.decorate('db', { connected: true });
}));

// 2. Scoped Plugin (Admin)
app.register(async (adminScope) => {
  // This middleware ONLY runs for /admin routes
  adminScope.use(async (ctx) => {
    if (ctx.req.headers.auth !== 'secret') throw new Error('Unauthorized');
  });

  adminScope.get('/dashboard', (ctx) => {
    ctx.send({ db: ctx.db.connected, admin: true });
  });
}, { prefix: '/admin' });

// 3. Scoped Plugin (Public)
app.register(async (publicScope) => {
  // No auth middleware here!
  publicScope.get('/home', (ctx) => {
    ctx.send({ db: ctx.db.connected, admin: false });
  });
}, { prefix: '/public' });
```

## 🔄 Lifecycle Hooks

Requests pass through the following pipeline:

**Incoming Request

1. onRequest (Global/Scope hooks)
2. Routing (Determines the Scope)
3. Body Parsing (JSON/Form-UrlEncoded)
4. Middlewares (Stack execution)
5. preValidation
6. Schema Validation (If schema provided)
7. preHandler
8. User Handler
9. onSend (Modify payload)
10. Response Sent
11. onResponse (Logging)

## 📚 API Reference

**linear(options)**

- timeout: Default 5000 (ms).
- bodyLimit: Default 1048576 (1MB).
- parseBody: Default true.

**Instance Methods**

- register(plugin, [options]): Registers a new plugin/scope.
- use(middleware): Adds a middleware (ctx) => Promise.
- addHook(name, handler): Adds a lifecycle hook.
- decorate(name, value): Adds a property to the Context prototype.
- get/post/put/delete/patch(path, [schema], handler): Registers routes.

**Context (ctx)**

- ctx.body: Parsed request body.
- ctx.query: Parsed query string.
- ctx.params: Route parameters.
- ctx.send(data): Sends response (auto-serializes JSON).
- ctx.json(data): Sets JSON header and sends.
- ctx.status(code): Sets HTTP status code.
- ctx.setHeader(name, value): Sets response header.

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

## 📄 License

![MIT](https://www.google.com/search?q=LICENSE)