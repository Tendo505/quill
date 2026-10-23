import type { Position } from "./errors.js";

// ---------- expressions ----------

export type Expr =
  | { kind: "Literal"; pos: Position; value: number | string | boolean | null }
  | { kind: "Template"; pos: Position; strings: string[]; exprs: Expr[] }
  | { kind: "Variable"; pos: Position; name: string; depth?: number }
  | { kind: "Assign"; pos: Position; name: string; op: AssignOp; value: Expr; depth?: number }
  | { kind: "Unary"; pos: Position; op: "-" | "!" | "not"; operand: Expr }
  | { kind: "Binary"; pos: Position; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "Logical"; pos: Position; op: "and" | "or"; left: Expr; right: Expr }
  | { kind: "Conditional"; pos: Position; test: Expr; then: Expr; otherwise: Expr }
  | { kind: "Call"; pos: Position; callee: Expr; args: Expr[] }
  | { kind: "Index"; pos: Position; object: Expr; index: Expr }
  | { kind: "SetIndex"; pos: Position; object: Expr; index: Expr; op: AssignOp; value: Expr }
  | { kind: "List"; pos: Position; items: Expr[] }
  | { kind: "Map"; pos: Position; entries: [Expr, Expr][] }
  | FunctionExpr;

export interface FunctionExpr {
  kind: "Function";
  pos: Position;
  name: string | null;
  params: string[];
  body: Stmt[];
}

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=";
export type BinaryOp =
  | "+" | "-" | "*" | "/" | "%" | "**"
  | "==" | "!=" | "<" | "<=" | ">" | ">=" | "in";

// ---------- statements ----------

export type Stmt =
  | { kind: "Expression"; pos: Position; expr: Expr }
  | { kind: "Let"; pos: Position; name: string; init: Expr | null; isConst: boolean }
  /** `scoped` is set by the resolver: false when the block declares nothing, so no scope is needed. */
  | { kind: "Block"; pos: Position; body: Stmt[]; scoped?: boolean }
  | { kind: "If"; pos: Position; test: Expr; then: Stmt; otherwise: Stmt | null }
  | { kind: "While"; pos: Position; test: Expr; body: Stmt }
  | { kind: "For"; pos: Position; name: string; iterable: Expr; body: Stmt }
  | { kind: "Return"; pos: Position; value: Expr | null }
  | { kind: "Break"; pos: Position }
  | { kind: "Continue"; pos: Position }
  | { kind: "FnDecl"; pos: Position; fn: FunctionExpr }
  | { kind: "Try"; pos: Position; body: Stmt; name: string; handler: Stmt }
  | { kind: "Throw"; pos: Position; value: Expr };

export type Program = Stmt[];
