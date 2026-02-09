import http from 'http';
import { URL } from 'url';
import { parse as parseQuery } from 'querystring';

/**
 * ==============================================================================
 * RADIX ROUTER
 * Optimized for O(k) lookup speed. Stores the 'Scope' in the leaf node.
 * ==============================================================================
 */
class Node {
  constructor(part = '', isParam = false) {
    this.part = part;
    this.isParam = isParam;
    this.paramName = '';
    this.children = {};
    this.paramChild = null;
    this.store = null;
  }
}

class Router {
  constructor() { this.root = new Node(); }
  
  insert(path, data) {
    let node = this.root;
    const parts = path.split('/').filter(p => p.length > 0);
    for (const part of parts) {
      if (part.startsWith(':')) {
        const paramName = part.slice(1);
        if (!node.paramChild) {
          node.paramChild = new Node(part, true);
          node.paramChild.paramName = paramName;
        }
        node = node.paramChild;
      } else {
        if (!node.children[part]) node.children[part] = new Node(part, false);
        node = node.children[part];
      }
    }
    node.store = data; 
  }

  lookup(path) {
    let node = this.root;
    const parts = path.split('/').filter(p => p.length > 0);
    const params = {};
    for (const part of parts) {
      if (node.children[part]) node = node.children[part];
      else if (node.paramChild) {
        node = node.paramChild;
        params[node.paramName] = part;
      } else return null;
    }
    return node.store ? { ...node.store, params } : null;
  }
}

/**
 * ==============================================================================
 * CONTEXT
 * Inherits decorators from the current Plugin Scope via Prototype Chain.
 * ==============================================================================
 */
class Context {
  constructor(req, res, scope) {
    this.req = req;
    this.res = res;
    this.scope = scope;
    this.method = req.method;
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    this.path = url.pathname;
    this.query = Object.fromEntries(url.searchParams);
    
    this.params = {};
    this.body = null;
    this.responded = false;
    this.payload = null;
    this.error = null;

    Object.assign(this, scope.decorators);
  }

  status(code) { this.res.statusCode = code; return this; }
  setHeader(name, value) { this.res.setHeader(name, value); return this; }
  json(data) {
    this.setHeader('Content-Type', 'application/json');
    return this.send(data);
  }
}

/**
 * ==============================================================================
 * LINEAR FRAMEWORK (The Core)
 * Implements Fastify-like Encapsulation.
 * ==============================================================================
 */
const kSkipOverride = Symbol('skip-override');

class Linear {
  constructor(options = {}, parent = null) {
    this.parent = parent;

    if (parent) {
      // Child Scope Initialization
      this.server = parent.server;
      this.routers = parent.routers;
      this.rootConfig = parent.rootConfig;
      this.prefix = (parent.prefix || '') + (options.prefix || '');
      
      // Prototype Inheritance for Decorators
      this.decorators = Object.create(parent.decorators);
      
      // Copy-on-Write for Middlewares & Hooks
      this.middlewares = [...parent.middlewares];
      this.hooks = {
        onRequest: [...parent.hooks.onRequest],
        preValidation: [...parent.hooks.preValidation],
        preHandler: [...parent.hooks.preHandler],
        onSend: [...parent.hooks.onSend],
        onResponse: [...parent.hooks.onResponse],
        onError: [...parent.hooks.onError],
        onTimeout: [...parent.hooks.onTimeout]
      };
    } else {
      // Root Scope Initialization
      this.server = null;
      this.routers = { GET: new Router(), POST: new Router(), PUT: new Router(), DELETE: new Router(), PATCH: new Router() };
      this.rootConfig = { timeout: 5000, bodyLimit: 1024 * 1024, parseBody: true, ...options };
      this.prefix = '';
      this.decorators = {};
      this.middlewares = [];
      this.hooks = {
        onRequest: [], preValidation: [], preHandler: [],
        onSend: [], onResponse: [], onError: [], onTimeout: []
      };
    }
  }

  decorate(name, value) {
    this.decorators[name] = value;
    return this;
  }

  use(fn) {
    this.middlewares.push(fn);
    return this;
  }

  addHook(name, fn) {
    if (this.hooks[name]) this.hooks[name].push(fn);
    return this;
  }

  async register(plugin, options = {}) {
    if (plugin[kSkipOverride]) {
      await plugin(this, options);
      return this;
    }
    const childScope = new Linear(options, this);
    await plugin(childScope, options);
    return this;
  }

  addRoute(method, path, handlers, schema) {
    const fullPath = this.prefix + path;
    this.routers[method].insert(fullPath, { handlers, schema, scope: this });
  }

  get(path, ...args) { this._reg('GET', path, args); }
  post(path, ...args) { this._reg('POST', path, args); }
  put(path, ...args) { this._reg('PUT', path, args); }
  delete(path, ...args) { this._reg('DELETE', path, args); }
  patch(path, ...args) { this._reg('PATCH', path, args); }

  _reg(method, path, args) {
    const schema = typeof args[0] === 'object' && !Array.isArray(args[0]) ? args.shift() : null;
    this.addRoute(method, path, args, schema);
  }

  async run(ctx, handlers) {
    for (const handler of handlers) {
      if (ctx.responded) break;
      const res = handler(ctx);
      if (res && res.then) await res;
    }
  }

  async _parseBody(req) {
    if (['GET', 'HEAD'].includes(req.method)) return null;
    return new Promise((resolve, reject) => {
      let body = '';
      let received = 0;
      req.on('data', chunk => {
        received += chunk.length;
        if (received > this.rootConfig.bodyLimit) {
          req.destroy();
          reject(new Error('Payload Too Large'));
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (!body) return resolve(null);
        try {
          const type = (req.headers['content-type'] || '').toLowerCase();
          if (type.includes('application/json')) resolve(JSON.parse(body));
          else if (type.includes('application/x-www-form-urlencoded')) resolve(parseQuery(body));
          else resolve(body);
        } catch (e) { reject(new Error('Invalid Body')); }
      });
      req.on('error', reject);
    });
  }

  listen(port, cb) {
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const router = this.routers[req.method];
      const match = router ? router.lookup(url.pathname) : null;
      const scope = match ? match.scope : this;
      const ctx = scope.createContext(req, res);
      if (match) ctx.params = match.params;

      const timer = setTimeout(() => {
        if (!ctx.responded) {
          ctx.error = new Error('Gateway Timeout');
          scope.run(ctx, scope.hooks.onTimeout).catch(console.error);
          if (!ctx.responded) ctx.status(504).send({ error: 'Gateway Timeout' });
        }
      }, this.rootConfig.timeout);

      try {
        await scope.run(ctx, scope.hooks.onRequest);
        if (ctx.responded) return;

        if (this.rootConfig.parseBody && ctx.body === null) {
          try { ctx.body = await this._parseBody(req); } catch(e) { throw e; }
        }

        await scope.run(ctx, scope.middlewares);
        if (ctx.responded) return;

        if (match) {
          await scope.run(ctx, scope.hooks.preValidation);
          if (ctx.responded) return;
          // Schema validation point
          await scope.run(ctx, scope.hooks.preHandler);
          if (ctx.responded) return;
          await scope.run(ctx, match.handlers);
        } else {
          ctx.status(404).send({ error: 'Not Found', path: ctx.path });
        }
      } catch (err) {
        ctx.error = err;
        try { await scope.run(ctx, scope.hooks.onError); } catch (e) { console.error(e); }
        if (!ctx.responded) {
          const status = ctx.res.statusCode === 200 ? 500 : ctx.res.statusCode;
          ctx.status(status).send({ error: err.message || 'Internal Server Error' });
        }
      } finally {
        clearTimeout(timer);
      }
    });
    return this.server.listen(port, cb);
  }

  createContext(req, res) {
    const ctx = new Context(req, res, this);
    const instance = this;
    ctx.send = async function(data) {
      if (this.responded || this.res.writableEnded) return;
      this.payload = data;
      try {
        await instance.run(this, instance.hooks.onSend);
        let body = this.payload;
        const isObj = typeof body === 'object' && body !== null;
        if (isObj) body = JSON.stringify(body);
        else body = String(body || '');
        if (!this.res.headersSent) {
          if (isObj && !this.res.getHeader('Content-Type')) this.res.setHeader('Content-Type', 'application/json');
          this.res.setHeader('Content-Length', Buffer.byteLength(body));
          this.res.writeHead(this.res.statusCode || 200);
        }
        this.res.end(body);
        this.responded = true;
        setImmediate(() => { instance.run(this, instance.hooks.onResponse).catch(console.error); });
      } catch (e) {
        console.error('Send Error', e);
        if (!this.res.headersSent) this.res.end();
      }
    };
    return ctx;
  }
}

export const fp = (fn) => { fn[kSkipOverride] = true; return fn; };
export default (opts) => new Linear(opts);