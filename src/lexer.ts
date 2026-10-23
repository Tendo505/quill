import { QuillError, type Position } from "./errors.js";

export type TokenType =
  // single-character punctuation
  | "(" | ")" | "[" | "]" | "{" | "}" | "," | "." | ";" | ":" | "?"
  // operators
  | "+" | "-" | "*" | "/" | "%" | "**" | "!" | "=" | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "=>" | "|>" | "+=" | "-=" | "*=" | "/="
  // literals
  | "number" | "string" | "template" | "identifier"
  // keywords
  | "let" | "const" | "fn" | "return" | "if" | "else" | "while" | "for" | "in"
  | "break" | "continue" | "true" | "false" | "nil" | "and" | "or" | "not"
  | "try" | "catch" | "throw"
  | "eof";

export const KEYWORDS = new Set<TokenType>([
  "let", "const", "fn", "return", "if", "else", "while", "for", "in", "break", "continue",
  "true", "false", "nil", "and", "or", "not", "try", "catch", "throw",
]);

/** A `${...}` hole inside a template string: raw source plus where it starts. */
export interface TemplatePart {
  source: string;
  pos: Position;
}

export interface Token {
  type: TokenType;
  lexeme: string;
  /** number value, unescaped string, or template pieces */
  value?: number | string | { strings: string[]; holes: TemplatePart[] };
  pos: Position;
  /** offset into the source, used by the playground's syntax highlighter */
  start: number;
  end: number;
}

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", '"': '"', "'": "'", "`": "`", $: "$",
};

const TWO_CHAR = ["**", "==", "!=", "<=", ">=", "=>", "|>", "+=", "-=", "*=", "/="];
const ONE_CHAR = "()[]{},.;:?+-*/%!=<>";

export class Lexer {
  private pos = 0;
  private line: number;
  private col: number;
  private readonly tokens: Token[] = [];

  constructor(private readonly src: string, start: Position = { line: 1, col: 1 }) {
    this.line = start.line;
    this.col = start.col;
  }

  tokenize(): Token[] {
    while (true) {
      this.skipTrivia();
      if (this.pos >= this.src.length) break;
      this.scanToken();
    }
    this.tokens.push({ type: "eof", lexeme: "", pos: this.here(), start: this.pos, end: this.pos });
    return this.tokens;
  }

  private here(): Position {
    return { line: this.line, col: this.col };
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  private advance(): string {
    const ch = this.src[this.pos++];
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  private error(message: string, pos: Position = this.here()): never {
    throw new QuillError("SyntaxError", message, pos);
  }

  private skipTrivia(): void {
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.advance();
      } else if (ch === "/" && this.peek(1) === "*") {
        const start = this.here();
        this.advance();
        this.advance();
        while (!(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.pos >= this.src.length) this.error("Unterminated block comment", start);
          this.advance();
        }
        this.advance();
        this.advance();
      } else {
        break;
      }
    }
  }

  private push(type: TokenType, start: number, pos: Position, value?: Token["value"]): void {
    this.tokens.push({ type, lexeme: this.src.slice(start, this.pos), value, pos, start, end: this.pos });
  }

  private scanToken(): void {
    const start = this.pos;
    const pos = this.here();
    const ch = this.peek();

    if (isDigit(ch)) return this.number(start, pos);
    if (isIdentStart(ch)) return this.identifier(start, pos);
    if (ch === '"' || ch === "'") return this.string(start, pos, ch);
    if (ch === "`") return this.template(start, pos);

    for (const op of TWO_CHAR) {
      if (this.src.startsWith(op, this.pos)) {
        for (let i = 0; i < op.length; i++) this.advance();
        return this.push(op as TokenType, start, pos);
      }
    }
    if (ONE_CHAR.includes(ch)) {
      this.advance();
      return this.push(ch as TokenType, start, pos);
    }
    if (ch === "&" && this.peek(1) === "&") this.error("Use 'and' instead of '&&'");
    if (ch === "|" && this.peek(1) === "|") this.error("Use 'or' instead of '||'");
    this.error(`Unexpected character '${ch}'`);
  }

  private number(start: number, pos: Position): void {
    while (isDigit(this.peek()) || this.peek() === "_") this.advance();
    if (this.peek() === "." && isDigit(this.peek(1))) {
      this.advance();
      while (isDigit(this.peek()) || this.peek() === "_") this.advance();
    }
    if ((this.peek() === "e" || this.peek() === "E") && (isDigit(this.peek(1)) || ((this.peek(1) === "-" || this.peek(1) === "+") && isDigit(this.peek(2))))) {
      this.advance();
      if (this.peek() === "-" || this.peek() === "+") this.advance();
      while (isDigit(this.peek())) this.advance();
    }
    if (isIdentStart(this.peek())) this.error(`Invalid number literal`, pos);
    const text = this.src.slice(start, this.pos).replace(/_/g, "");
    this.push("number", start, pos, Number(text));
  }

  private identifier(start: number, pos: Position): void {
    while (isIdentPart(this.peek())) this.advance();
    const text = this.src.slice(start, this.pos);
    const type = KEYWORDS.has(text as TokenType) ? (text as TokenType) : "identifier";
    this.push(type, start, pos);
  }

  private escape(): string {
    const escPos = this.here();
    this.advance(); // backslash
    const esc = this.advance();
    if (esc === "u" && this.peek() === "{") {
      this.advance();
      let hex = "";
      while (this.peek() !== "}" && this.pos < this.src.length) hex += this.advance();
      this.advance();
      const code = parseInt(hex, 16);
      if (!/^[0-9a-fA-F]{1,6}$/.test(hex) || code > 0x10ffff) this.error(`Invalid unicode escape '\\u{${hex}}'`, escPos);
      return String.fromCodePoint(code);
    }
    if (!(esc in ESCAPES)) this.error(`Unknown escape sequence '\\${esc}'`, escPos);
    return ESCAPES[esc];
  }

  private string(start: number, pos: Position, quote: string): void {
    this.advance();
    let value = "";
    while (this.peek() !== quote) {
      if (this.pos >= this.src.length || this.peek() === "\n") this.error("Unterminated string", pos);
      value += this.peek() === "\\" ? this.escape() : this.advance();
    }
    this.advance();
    this.push("string", start, pos, value);
  }

  /** `text ${expr} more` → strings ["text ", " more"], holes [expr source + position] */
  private template(start: number, pos: Position): void {
    this.advance();
    const strings: string[] = [];
    const holes: TemplatePart[] = [];
    let current = "";

    while (this.peek() !== "`") {
      if (this.pos >= this.src.length) this.error("Unterminated template string", pos);
      if (this.peek() === "\\") {
        current += this.escape();
      } else if (this.peek() === "$" && this.peek(1) === "{") {
        const holeStart = this.here();
        this.advance();
        this.advance();
        const exprPos = this.here();
        const exprStart = this.pos;
        let depth = 1;
        while (depth > 0) {
          if (this.pos >= this.src.length) this.error("Unterminated '${' in template string", holeStart);
          const ch = this.peek();
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          if (depth > 0) this.advance();
        }
        const source = this.src.slice(exprStart, this.pos);
        if (source.trim() === "") this.error("Empty '${}' in template string", holeStart);
        this.advance(); // closing }
        strings.push(current);
        current = "";
        holes.push({ source, pos: exprPos });
      } else {
        current += this.advance();
      }
    }
    this.advance();
    strings.push(current);
    this.push("template", start, pos, { strings, holes });
  }
}

const isDigit = (ch: string) => ch >= "0" && ch <= "9";
const isIdentStart = (ch: string) => (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
const isIdentPart = (ch: string) => isIdentStart(ch) || isDigit(ch);

export function tokenize(src: string): Token[] {
  return new Lexer(src).tokenize();
}
