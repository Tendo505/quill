// Recursive-descent parser for statements, Pratt (precedence-climbing) parser
// for expressions. Produces the AST in ast.ts.

import type { AssignOp, BinaryOp, Expr, FunctionExpr, Program, Stmt } from "./ast.js";
import { QuillError, type Position } from "./errors.js";
import { Lexer, type Token, type TokenType } from "./lexer.js";

// Binding power for infix operators. Higher binds tighter.
const enum Prec {
  None = 0,
  Assign = 1,      // = += -= ...   (right assoc)
  Conditional = 2, // ?:            (right assoc)
  Pipe = 3,        // |>
  Or = 4,
  And = 5,
  Equality = 6,    // == !=
  Compare = 7,     // < <= > >= in
  Sum = 8,         // + -
  Product = 9,     // * / %
  Unary = 10,      // - ! not
  Power = 11,      // **            (right assoc, binds tighter than unary on its left)
  Call = 12,       // () [] .
}

const INFIX: Partial<Record<TokenType, Prec>> = {
  "=": Prec.Assign, "+=": Prec.Assign, "-=": Prec.Assign, "*=": Prec.Assign, "/=": Prec.Assign,
  "?": Prec.Conditional,
  "|>": Prec.Pipe,
  or: Prec.Or,
  and: Prec.And,
  "==": Prec.Equality, "!=": Prec.Equality,
  "<": Prec.Compare, "<=": Prec.Compare, ">": Prec.Compare, ">=": Prec.Compare, in: Prec.Compare,
  "+": Prec.Sum, "-": Prec.Sum,
  "*": Prec.Product, "/": Prec.Product, "%": Prec.Product,
  "**": Prec.Power,
  "(": Prec.Call, "[": Prec.Call, ".": Prec.Call,
};

export class Parser {
  private current = 0;
  /** Inside `for (x in ...)` the `in` operator must not be parsed as membership. */
  private noIn = false;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Program {
    const body: Stmt[] = [];
    while (!this.check("eof")) body.push(this.declaration());
    return body;
  }

  // ---------- token helpers ----------

  private peek(): Token {
    return this.tokens[this.current];
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }

  private check(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private checkNext(type: TokenType): boolean {
    return this.tokens[this.current + 1]?.type === type;
  }

  private advance(): Token {
    if (!this.check("eof")) this.current++;
    return this.previous();
  }

  private match(...types: TokenType[]): boolean {
    if (types.some((t) => this.check(t))) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    this.error(message, this.peek());
  }

  private error(message: string, token: Token): never {
    const where = token.type === "eof" ? "end of input" : `'${token.lexeme}'`;
    throw new QuillError("SyntaxError", `${message} (found ${where})`, token.pos);
  }

  private identifier(message: string): string {
    return this.expect("identifier", message).lexeme;
  }

  // ---------- statements ----------

  private declaration(): Stmt {
    if (this.check("fn") && this.checkNext("identifier")) {
      const pos = this.advance().pos;
      const name = this.identifier("Expected function name");
      const fn = this.functionRest(pos, name);
      this.match(";"); // optional, and natural after `fn f(x) => x;`
      return { kind: "FnDecl", pos, fn };
    }
    if (this.check("let") || this.check("const")) return this.letDeclaration();
    return this.statement();
  }

  private letDeclaration(): Stmt {
    const keyword = this.advance();
    const isConst = keyword.type === "const";
    const nameTok = this.expect("identifier", `Expected variable name after '${keyword.lexeme}'`);
    let init: Expr | null = null;
    if (this.match("=")) init = this.expression();
    else if (isConst) this.error("A const must be initialised", this.peek());
    this.semicolon();
    return { kind: "Let", pos: nameTok.pos, name: nameTok.lexeme, init, isConst };
  }

  private statement(): Stmt {
    const tok = this.peek();
    switch (tok.type) {
      case "{": return this.block();
      case "if": return this.ifStatement();
      case "while": return this.whileStatement();
      case "for": return this.forStatement();
      case "try": return this.tryStatement();
      case "return": {
        this.advance();
        const value = this.check(";") || this.check("}") || this.check("eof") ? null : this.expression();
        this.semicolon();
        return { kind: "Return", pos: tok.pos, value };
      }
      case "break":
      case "continue":
        this.advance();
        this.semicolon();
        return { kind: tok.type === "break" ? "Break" : "Continue", pos: tok.pos };
      case "throw": {
        this.advance();
        const value = this.expression();
        this.semicolon();
        return { kind: "Throw", pos: tok.pos, value };
      }
      default: {
        const expr = this.expression();
        this.semicolon();
        return { kind: "Expression", pos: tok.pos, expr };
      }
    }
  }

  /** Semicolons are required between statements on the same line, optional before `}` or a newline. */
  private semicolon(): void {
    if (this.match(";")) return;
    if (this.check("}") || this.check("eof")) return;
    if (this.peek().pos.line > this.previous().pos.line) return;
    this.error("Expected ';' after statement", this.peek());
  }

  private block(): Stmt & { kind: "Block" } {
    const pos = this.expect("{", "Expected '{'").pos;
    const body: Stmt[] = [];
    while (!this.check("}") && !this.check("eof")) body.push(this.declaration());
    this.expect("}", "Expected '}' to close block");
    return { kind: "Block", pos, body };
  }

  private condition(keyword: string): Expr {
    this.expect("(", `Expected '(' after '${keyword}'`);
    const test = this.expression();
    this.expect(")", `Expected ')' after ${keyword} condition`);
    return test;
  }

  private ifStatement(): Stmt {
    const pos = this.advance().pos;
    const test = this.condition("if");
    const then = this.block();
    let otherwise: Stmt | null = null;
    if (this.match("else")) otherwise = this.check("if") ? this.ifStatement() : this.block();
    return { kind: "If", pos, test, then, otherwise };
  }

  private whileStatement(): Stmt {
    const pos = this.advance().pos;
    const test = this.condition("while");
    return { kind: "While", pos, test, body: this.block() };
  }

  private forStatement(): Stmt {
    const pos = this.advance().pos;
    this.expect("(", "Expected '(' after 'for'");
    this.match("let");
    const name = this.identifier("Expected loop variable name");
    this.expect("in", "Expected 'in' after loop variable");
    const iterable = this.expression();
    this.expect(")", "Expected ')' after for clause");
    return { kind: "For", pos, name, iterable, body: this.block() };
  }

  private tryStatement(): Stmt {
    const pos = this.advance().pos;
    const body = this.block();
    this.expect("catch", "Expected 'catch' after try block");
    this.expect("(", "Expected '(' after 'catch'");
    const name = this.identifier("Expected error variable name");
    this.expect(")", "Expected ')' after catch variable");
    return { kind: "Try", pos, body, name, handler: this.block() };
  }

  // ---------- expressions ----------

  expression(minPrec: Prec = Prec.Assign): Expr {
    let left = this.prefix();
    while (true) {
      const type = this.peek().type;
      const prec = INFIX[type];
      if (prec === undefined || prec < minPrec) break;
      if (type === "in" && this.noIn) break;
      left = this.infix(left, this.advance());
    }
    return left;
  }

  private prefix(): Expr {
    const tok = this.advance();
    const pos = tok.pos;
    switch (tok.type) {
      case "number":
      case "string":
        return { kind: "Literal", pos, value: tok.value as number | string };
      case "true": return { kind: "Literal", pos, value: true };
      case "false": return { kind: "Literal", pos, value: false };
      case "nil": return { kind: "Literal", pos, value: null };
      case "template": return this.template(tok);
      case "identifier": return { kind: "Variable", pos, name: tok.lexeme };
      case "(": {
        const saved = this.noIn;
        this.noIn = false;
        const expr = this.expression();
        this.noIn = saved;
        this.expect(")", "Expected ')' after expression");
        return expr;
      }
      case "-":
      case "!":
      case "not":
        return { kind: "Unary", pos, op: tok.type, operand: this.expression(Prec.Unary) };
      case "[": return this.listLiteral(pos);
      case "{": return this.mapLiteral(pos);
      case "fn": return this.functionRest(pos, null);
      default:
        this.error("Expected an expression", tok);
    }
  }

  private infix(left: Expr, op: Token): Expr {
    const pos = op.pos;
    switch (op.type) {
      case "=": case "+=": case "-=": case "*=": case "/=": {
        const value = this.expression(Prec.Assign); // right associative
        const assignOp = op.type as AssignOp;
        if (left.kind === "Variable") return { kind: "Assign", pos: left.pos, name: left.name, op: assignOp, value };
        if (left.kind === "Index") return { kind: "SetIndex", pos, object: left.object, index: left.index, op: assignOp, value };
        throw new QuillError("SyntaxError", "Invalid assignment target", left.pos);
      }
      case "?": {
        const then = this.expression(Prec.Assign);
        this.expect(":", "Expected ':' in conditional expression");
        const otherwise = this.expression(Prec.Conditional);
        return { kind: "Conditional", pos, test: left, then, otherwise };
      }
      case "|>": {
        // x |> f(a, b)  ==>  f(x, a, b)      x |> f  ==>  f(x)
        const right = this.expression(Prec.Pipe + 1);
        if (right.kind === "Call") return { ...right, args: [left, ...right.args] };
        return { kind: "Call", pos, callee: right, args: [left] };
      }
      case "and": case "or":
        return { kind: "Logical", pos, op: op.type, left, right: this.expression(INFIX[op.type]! + 1) };
      case "**":
        return { kind: "Binary", pos, op: "**", left, right: this.expression(Prec.Unary) }; // right assoc
      case "(": return this.call(left, pos);
      case "[": {
        const saved = this.noIn;
        this.noIn = false;
        const index = this.expression();
        this.noIn = saved;
        this.expect("]", "Expected ']' after index");
        return { kind: "Index", pos, object: left, index };
      }
      case ".": {
        const name = this.expect("identifier", "Expected property name after '.'");
        return { kind: "Index", pos, object: left, index: { kind: "Literal", pos: name.pos, value: name.lexeme } };
      }
      default:
        return { kind: "Binary", pos, op: op.type as BinaryOp, left, right: this.expression(INFIX[op.type]! + 1) };
    }
  }

  private call(callee: Expr, pos: Position): Expr {
    const args = this.commaList(")", "argument");
    return { kind: "Call", pos, callee, args };
  }

  private commaList(close: TokenType, what: string): Expr[] {
    const saved = this.noIn;
    this.noIn = false;
    const items: Expr[] = [];
    while (!this.check(close)) {
      items.push(this.expression());
      if (!this.match(",")) break;
    }
    this.expect(close, `Expected ',' or '${close}' after ${what}`);
    this.noIn = saved;
    return items;
  }

  private listLiteral(pos: Position): Expr {
    return { kind: "List", pos, items: this.commaList("]", "list item") };
  }

  private mapLiteral(pos: Position): Expr {
    const entries: [Expr, Expr][] = [];
    while (!this.check("}")) {
      const keyTok = this.peek();
      let key: Expr;
      if (keyTok.type === "identifier") {
        this.advance();
        key = { kind: "Literal", pos: keyTok.pos, value: keyTok.lexeme };
        // Shorthand { name } means { name: name }
        if (!this.check(":")) {
          entries.push([key, { kind: "Variable", pos: keyTok.pos, name: keyTok.lexeme }]);
          if (!this.match(",")) break;
          continue;
        }
      } else if (keyTok.type === "[") {
        this.advance();
        key = this.expression();
        this.expect("]", "Expected ']' after computed key");
      } else {
        key = this.expression(Prec.Call);
      }
      this.expect(":", "Expected ':' after map key");
      entries.push([key, this.expression()]);
      if (!this.match(",")) break;
    }
    this.expect("}", "Expected ',' or '}' in map literal");
    return { kind: "Map", pos, entries };
  }

  /** After `fn` (and optional name): params then `{ body }` or `=> expr`. */
  private functionRest(pos: Position, name: string | null): FunctionExpr {
    this.expect("(", "Expected '(' to start parameter list");
    const params: string[] = [];
    while (!this.check(")")) {
      const p = this.expect("identifier", "Expected parameter name");
      if (params.includes(p.lexeme)) throw new QuillError("SyntaxError", `Duplicate parameter '${p.lexeme}'`, p.pos);
      params.push(p.lexeme);
      if (!this.match(",")) break;
    }
    this.expect(")", "Expected ')' after parameters");

    if (this.match("=>")) {
      const valuePos = this.peek().pos;
      const value = this.expression();
      return { kind: "Function", pos, name, params, body: [{ kind: "Return", pos: valuePos, value }] };
    }
    const body = this.block().body;
    return { kind: "Function", pos, name, params, body };
  }

  private template(tok: Token): Expr {
    const { strings, holes } = tok.value as { strings: string[]; holes: { source: string; pos: Position }[] };
    const exprs = holes.map((hole) => {
      const parser = new Parser(new Lexer(hole.source, hole.pos).tokenize());
      const expr = parser.expression();
      if (!parser.check("eof")) parser.error("Unexpected token in template expression", parser.peek());
      return expr;
    });
    return { kind: "Template", pos: tok.pos, strings, exprs };
  }
}

export function parse(source: string): Program {
  return new Parser(new Lexer(source).tokenize()).parseProgram();
}
