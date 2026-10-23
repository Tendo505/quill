// Static scope analysis, run once before execution.
//
// For every local variable reference it records how many scopes up the
// binding lives (`depth`), so the interpreter can jump straight to the right
// environment instead of searching by name, and closures capture exactly the
// variable that was in scope where they were written. Unresolved names are
// globals, looked up dynamically at runtime.
//
// It also rejects programs that are wrong regardless of input:
//   - reading a local variable in its own initializer
//   - redeclaring a name in the same local scope
//   - assigning to a const
//   - return outside a function, break/continue outside a loop

import type { Expr, FunctionExpr, Program, Stmt } from "./ast.js";
import { QuillError, type Position } from "./errors.js";

interface Binding {
  ready: boolean;
  isConst: boolean;
}

export class Resolver {
  private scopes: Map<string, Binding>[] = [];
  private functionDepth = 0;
  private loopDepth = 0;

  /** @param globalConsts names already declared const at global scope (REPL sessions) */
  constructor(private readonly globalConsts: Set<string> = new Set()) {}

  resolve(program: Program): void {
    this.hoist(program, null);
    for (const stmt of program) this.stmt(stmt);
  }

  private error(message: string, pos: Position): never {
    throw new QuillError("ScopeError", message, pos);
  }

  private get scope(): Map<string, Binding> | undefined {
    return this.scopes[this.scopes.length - 1];
  }

  private declare(name: string, pos: Position, isConst: boolean, ready = false): void {
    const scope = this.scope;
    if (!scope) {
      // Global scope: allow redefinition (handy in a REPL), but remember consts.
      if (this.globalConsts.has(name)) this.error(`Cannot redeclare const '${name}'`, pos);
      if (isConst) this.globalConsts.add(name);
      return;
    }
    if (scope.has(name)) this.error(`'${name}' is already declared in this scope`, pos);
    scope.set(name, { ready, isConst });
  }

  /** Function declarations are hoisted so functions in one block can call each other. */
  private hoist(body: Stmt[], scope: Map<string, Binding> | null): void {
    for (const s of body) {
      if (s.kind !== "FnDecl" || !s.fn.name) continue;
      if (scope) {
        if (scope.has(s.fn.name)) this.error(`'${s.fn.name}' is already declared in this scope`, s.pos);
        scope.set(s.fn.name, { ready: true, isConst: false });
      }
    }
  }

  private lookup(name: string): { depth: number; binding: Binding } | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const binding = this.scopes[i].get(name);
      if (binding) return { depth: this.scopes.length - 1 - i, binding };
    }
    return null;
  }

  private block(body: Stmt[], extra: [string, Position][] = []): void {
    const scope = new Map<string, Binding>();
    this.scopes.push(scope);
    for (const [name, pos] of extra) this.declare(name, pos, false, true);
    this.hoist(body, scope);
    for (const s of body) this.stmt(s);
    this.scopes.pop();
  }

  // ---------- statements ----------

  private stmt(s: Stmt): void {
    switch (s.kind) {
      case "Expression": return this.expr(s.expr);
      case "Let":
        this.declare(s.name, s.pos, s.isConst);
        if (s.init) this.expr(s.init);
        if (this.scope) this.scope.get(s.name)!.ready = true;
        return;
      case "Block":
        // A block that declares nothing doesn't need its own scope. The
        // interpreter makes the same decision, so resolved depths still line up.
        s.scoped = s.body.some((x) => x.kind === "Let" || x.kind === "FnDecl");
        if (s.scoped) return this.block(s.body);
        for (const x of s.body) this.stmt(x);
        return;
      case "If":
        this.expr(s.test);
        this.stmt(s.then);
        if (s.otherwise) this.stmt(s.otherwise);
        return;
      case "While":
        this.expr(s.test);
        this.loop(() => this.stmt(s.body));
        return;
      case "For":
        this.expr(s.iterable);
        // The loop variable lives in its own scope wrapping the body, fresh per iteration.
        this.loop(() => this.block(s.body.kind === "Block" ? s.body.body : [s.body], [[s.name, s.pos]]));
        return;
      case "Return":
        if (this.functionDepth === 0) this.error("'return' outside of a function", s.pos);
        if (s.value) this.expr(s.value);
        return;
      case "Break":
      case "Continue":
        if (this.loopDepth === 0) this.error(`'${s.kind.toLowerCase()}' outside of a loop`, s.pos);
        return;
      case "FnDecl":
        if (!this.scope) this.declare(s.fn.name!, s.pos, false, true);
        this.fn(s.fn);
        return;
      case "Try":
        this.stmt(s.body);
        this.block(s.handler.kind === "Block" ? s.handler.body : [s.handler], [[s.name, s.pos]]);
        return;
      case "Throw":
        this.expr(s.value);
        return;
    }
  }

  private loop(body: () => void): void {
    this.loopDepth++;
    body();
    this.loopDepth--;
  }

  private fn(f: FunctionExpr): void {
    const savedLoop = this.loopDepth;
    this.loopDepth = 0; // break inside a nested function can't target an outer loop
    this.functionDepth++;
    this.block(f.body, f.params.map((p) => [p, f.pos]));
    this.functionDepth--;
    this.loopDepth = savedLoop;
  }

  // ---------- expressions ----------

  private expr(e: Expr): void {
    switch (e.kind) {
      case "Literal": return;
      case "Template": e.exprs.forEach((x) => this.expr(x)); return;
      case "Variable": {
        const found = this.lookup(e.name);
        if (found && !found.binding.ready) this.error(`Cannot read '${e.name}' in its own initializer`, e.pos);
        if (found) e.depth = found.depth;
        return;
      }
      case "Assign": {
        this.expr(e.value);
        const found = this.lookup(e.name);
        if (found?.binding.isConst || (!found && this.globalConsts.has(e.name))) {
          this.error(`Cannot assign to const '${e.name}'`, e.pos);
        }
        if (found) e.depth = found.depth;
        return;
      }
      case "Unary": return this.expr(e.operand);
      case "Binary":
      case "Logical":
        this.expr(e.left);
        this.expr(e.right);
        return;
      case "Conditional":
        this.expr(e.test);
        this.expr(e.then);
        this.expr(e.otherwise);
        return;
      case "Call":
        this.expr(e.callee);
        e.args.forEach((a) => this.expr(a));
        return;
      case "Index":
        this.expr(e.object);
        this.expr(e.index);
        return;
      case "SetIndex":
        this.expr(e.object);
        this.expr(e.index);
        this.expr(e.value);
        return;
      case "List": e.items.forEach((x) => this.expr(x)); return;
      case "Map":
        for (const [k, v] of e.entries) {
          this.expr(k);
          this.expr(v);
        }
        return;
      case "Function": return this.fn(e);
    }
  }
}
