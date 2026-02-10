import http from 'http';
import { URL } from 'url';
import { parse as parseQuery } from 'querystring';

/**
 * ==============================================================================
 * 1. RADIX ROUTER (路由层)
 * 优化用于 O(k) 查找速度。叶子节点存储 Scope (作用域)，实现插件隔离。
 * ==============================================================================
 */
class Node {
  constructor(part = '', isParam = false) {
    this.part = part;
    this.isParam = isParam;
    this.paramName = '';
    this.children = {};
    this.paramChild = null;
    this.store = null; // 存储 { handlers, schema, validators, scope }
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
 * 2. CONTEXT (请求上下文)
 * 通过原型链继承当前插件 Scope 的装饰器。
 * ==============================================================================
 */
class Context {
  constructor(req, res, scope) {
    this.req = req;
    this.res = res;
    this.scope = scope; // 指向处理该请求的 Linear 实例
    this.method = req.method;
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    this.path = url.pathname;
    this.query = Object.fromEntries(url.searchParams);
    
    this.params = {};
    this.body = null;
    this.responded = false;
    this.payload = null;
    this.error = null;

    // [继承魔法]
    // Context 继承自 Scope 的 decorators。
    // 读取 ctx.db 时，会沿着原型链向上查找。
    Object.assign(this, scope.decorators);
  }

  status(code) { this.res.statusCode = code; return this; }
  setHeader(name, value) { this.res.setHeader(name, value); return this; }
  
  json(data) {
    this.setHeader('Content-Type', 'application/json');
    return this.send(data);
  }

  redirect(url, code = 302) {
    this.status(code).setHeader('Location', url).send(null);
  }
}

/**
 * ==============================================================================
 * 3. DEFAULT VALIDATOR (默认简易校验器)
 * 当用户未设置 setValidatorCompiler 时使用的兜底方案。
 * ==============================================================================
 */
const defaultValidator = (schema) => {
  return (data) => {
    if (!schema) return null;
    if (schema.required && typeof data === 'object') {
      for (const key of schema.required) {
        if (!data || data[key] === undefined) return { message: `Missing required property: ${key}` };
      }
    }
    return null; 
  };
};

/**
 * ==============================================================================
 * 4. LINEAR FRAMEWORK (核心类)
 * 实现了 Fastify 风格的封装上下文。
 * ==============================================================================
 */
const kSkipOverride = Symbol('skip-override');

class Linear {
  constructor(options = {}, parent = null) {
    this.parent = parent;

    if (parent) {
      // --------------------------------------------------------
      // 子作用域初始化 (继承 & 隔离)
      // --------------------------------------------------------
      
      // 1. 共享引用 (全局单例)
      this.server = parent.server;
      this.routers = parent.routers;
      this.rootConfig = parent.rootConfig;

      // 2. 前缀累加
      this.prefix = (parent.prefix || '') + (options.prefix || '');

      // 3. 装饰器：原型链继承 (Prototype Inheritance)
      // 新增的装饰器挂载在 'this.decorators'，不影响 parent。
      // 读取时如果自己没有，去 parent 找。
      this.decorators = Object.create(parent.decorators);

      // 4. 校验编译器：继承
      this.validatorCompiler = parent.validatorCompiler;

      // 5. 中间件 & Hooks：写时复制 (Copy-on-Write)
      // 复制父级数组的快照。push 操作只影响当前及子 Scope。
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
      // --------------------------------------------------------
      // 根作用域初始化
      // --------------------------------------------------------
      this.server = null;
      this.routers = { GET: new Router(), POST: new Router(), PUT: new Router(), DELETE: new Router(), PATCH: new Router() };
      this.rootConfig = { timeout: 5000, bodyLimit: 1024 * 1024, parseBody: true, ...options };
      this.prefix = '';
      this.validatorCompiler = defaultValidator; // 默认使用简易校验
      
      this.decorators = {};
      this.middlewares = [];
      this.hooks = {
        onRequest: [], preValidation: [], preHandler: [],
        onSend: [], onResponse: [], onError: [], onTimeout: []
      };
    }
  }

  // --- 公共 API ---

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

  setValidatorCompiler(compiler) {
    this.validatorCompiler = compiler;
    return this;
  }

  // --- 插件注册系统 ---

  async register(plugin, options = {}) {
    // 如果插件被 fp() 包裹，跳过封装，直接修改当前 Scope
    if (plugin[kSkipOverride]) {
      await plugin(this, options);
      return this;
    }

    // 标准插件：创建新的封装 Scope
    const childScope = new Linear(options, this);
    await plugin(childScope, options);
    
    return this;
  }

  // --- 路由系统 ---

  addRoute(method, path, handlers, schema) {
    const fullPath = this.prefix + path;
    
    // 预编译 Schema (Build Time)
    const validators = {};
    if (schema) {
      if (schema.body) validators.body = this.validatorCompiler(schema.body);
      if (schema.querystring) validators.querystring = this.validatorCompiler(schema.querystring);
      if (schema.params) validators.params = this.validatorCompiler(schema.params);
    }

    // [关键] 我们将 当前 Scope (this) 绑定到路由节点上
    this.routers[method].insert(fullPath, { 
      handlers, 
      schema, 
      validators,
      scope: this 
    });
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

  // --- 执行引擎 ---

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

  // --- 请求处理入口 ---

  listen(port, cb) {
    this.server = http.createServer(async (req, res) => {
      // 1. 路由查找 (确定 Scope)
      // 我们需要先找到路由，才知道是哪个插件在处理这个请求
      const url = new URL(req.url, `http://${req.headers.host}`);
      const router = this.routers[req.method];
      const match = router ? router.lookup(url.pathname) : null;

      // 确定 Scope: 匹配到路由则用路由的 scope，否则用 Root scope
      const scope = match ? match.scope : this;

      // 2. 创建绑定到 Scope 的 Context
      const ctx = scope.createContext(req, res);
      if (match) ctx.params = match.params;

      // 0. 超时看门狗
      const timer = setTimeout(() => {
        if (!ctx.responded) {
          ctx.error = new Error('Gateway Timeout');
          scope.run(ctx, scope.hooks.onTimeout).catch(console.error);
          if (!ctx.responded) ctx.status(504).send({ error: 'Gateway Timeout' });
        }
      }, this.rootConfig.timeout);

      try {
        // [Lifecycle 1] onRequest (系统级钩子)
        await scope.run(ctx, scope.hooks.onRequest);
        if (ctx.responded) return;

        // [Lifecycle 2] Body 解析
        if (this.rootConfig.parseBody && ctx.body === null) {
          try {
             ctx.body = await this._parseBody(req);
          } catch(e) {
             throw e; // 交给 onError 处理
          }
        }

        // [Lifecycle 3] 中间件 (继承的堆栈)
        await scope.run(ctx, scope.middlewares);
        if (ctx.responded) return;

        if (match) {
          // [Lifecycle 4] preValidation
          await scope.run(ctx, scope.hooks.preValidation);
          if (ctx.responded) return;

          // [Lifecycle 5] Schema 校验 (Validator Compiler)
          if (match.validators) {
             const v = match.validators;
             let err = null;
             if (v.body) err = v.body(ctx.body);
             if (!err && v.querystring) err = v.querystring(ctx.query);
             if (!err && v.params) err = v.params(ctx.params);

             if (err) {
                 ctx.status(400).send({ error: 'Validation Failed', details: err });
                 return;
             }
          }

          // [Lifecycle 6] preHandler
          await scope.run(ctx, scope.hooks.preHandler);
          if (ctx.responded) return;

          // [Lifecycle 7] 业务 Handler
          await scope.run(ctx, match.handlers);
        } else {
          ctx.status(404).send({ error: 'Not Found', path: ctx.path });
        }

      } catch (err) {
        // [Lifecycle Error] onError
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
    const ctx = new Context(req, res, this); // this 是当前 Scope
    const instance = this;

    ctx.send = async function(data) {
      if (this.responded || this.res.writableEnded) return;
      this.payload = data;

      try {
        // [Lifecycle 8] onSend (允许修改 payload)
        await instance.run(this, instance.hooks.onSend);
        
        let body = this.payload;
        const isObj = typeof body === 'object' && body !== null;
        if (isObj) body = JSON.stringify(body);
        else body = String(body || '');

        if (!this.res.headersSent) {
          if (isObj && !this.res.getHeader('Content-Type')) this.res.setHeader('Content-Type', 'application/json');
          if (!this.res.getHeader('Content-Length')) this.res.setHeader('Content-Length', Buffer.byteLength(body));
          this.res.writeHead(this.res.statusCode || 200);
        }

        this.res.end(body);
        this.responded = true;

        // [Lifecycle 9] onResponse (日志/统计)
        setImmediate(() => {
          instance.run(this, instance.hooks.onResponse).catch(console.error);
        });

      } catch (e) {
        console.error('Send Error', e);
        if (!this.res.headersSent) this.res.end();
      }
    };
    return ctx;
  }
}

// 导出 fp 辅助函数用于打破封装
export const fp = (fn) => { fn[kSkipOverride] = true; return fn; };
export default (opts) => new Linear(opts);