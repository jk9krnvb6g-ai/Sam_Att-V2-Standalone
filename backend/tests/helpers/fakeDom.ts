/**
 * Minimal virtual DOM environment for running real React 19 component tests
 * (`react-dom/client` + `React.act` + `<React.StrictMode>`) inside `node --test`.
 */

export class FakeNode {
  public nodeType: number;
  public nodeName: string;
  public parentNode: FakeNode | null = null;
  public childNodes: FakeNode[] = [];
  public ownerDocument: FakeDocument | null = null;
  public textContentValue = '';
  public eventListeners = new Map<string, Set<(event: any) => void>>();

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null = null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.childNodes.length
      ? this.parentNode.childNodes[idx + 1]
      : null;
  }

  get previousSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.childNodes.indexOf(this);
    return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
  }

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.textContentValue;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(val: string) {
    const str = val == null ? '' : String(val);
    if (this.nodeType === 3 || this.nodeType === 8) {
      this.textContentValue = str;
      return;
    }
    this.childNodes = [];
    if (str.length > 0 && this.ownerDocument) {
      const txt = this.ownerDocument.createTextNode(str);
      txt.parentNode = this;
      this.childNodes.push(txt);
    }
  }

  get nodeValue(): string {
    return this.textContentValue;
  }

  set nodeValue(val: string) {
    this.textContentValue = val == null ? '' : String(val);
  }

  get data(): string {
    return this.textContentValue;
  }

  set data(val: string) {
    this.textContentValue = val == null ? '' : String(val);
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, refNode: FakeNode | null): FakeNode {
    if (child.nodeType === 11) {
      const items = [...child.childNodes];
      child.childNodes = [];
      for (const item of items) {
        this.insertBefore(item, refNode);
      }
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument ?? (this as unknown as FakeDocument);
    if (refNode) {
      const idx = this.childNodes.indexOf(refNode);
      if (idx >= 0) {
        this.childNodes.splice(idx, 0, child);
        return child;
      }
    }
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const idx = this.childNodes.indexOf(child);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }

  contains(other: FakeNode | null): boolean {
    if (!other) return false;
    if (other === this) return true;
    return this.childNodes.some((c) => c.contains(other));
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.eventListeners.get(type);
    if (!set) {
      set = new Set();
      this.eventListeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: any): boolean {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    let cur: FakeNode | null = this;
    const path: FakeNode[] = [];
    while (cur) {
      path.push(cur);
      cur = cur.parentNode;
    }
    // Capture phase (minimal) + bubble phase
    for (let i = path.length - 1; i >= 0; i--) {
      if (event._stoppedImmediate) break;
      event.currentTarget = path[i];
      // Trigger direct bubble listeners from target up after capture loop
    }
    for (let i = 0; i < path.length; i++) {
      if (event.cancelBubble || event._stopped) break;
      const node = path[i];
      event.currentTarget = node;
      const listeners = node.eventListeners.get(event.type);
      if (listeners) {
        for (const fn of [...listeners]) {
          fn(event);
          if (event._stoppedImmediate) break;
        }
      }
    }
    return !event.defaultPrevented;
  }
}

export class FakeElement extends FakeNode {
  public tagName: string;
  public namespaceURI = 'http://www.w3.org/1999/xhtml';
  public attributes = new Map<string, string>();
  public style: Record<string, string> = {};
  public value = '';
  public checked = false;
  public disabled = false;
  public type = '';
  public className = '';
  public classList = {
    add: (..._cls: string[]) => {},
    remove: (..._cls: string[]) => {},
    contains: (_cls: string) => false,
    toggle: (_cls: string) => false,
  };
  public dataset: Record<string, string> = {};

  constructor(tagName: string, ownerDocument: FakeDocument, namespaceURI?: string) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
    if (namespaceURI) this.namespaceURI = namespaceURI;
  }

  setAttribute(name: string, value: string): void {
    const str = String(value);
    this.attributes.set(name, str);
    if (name === 'disabled') this.disabled = true;
    if (name === 'type') this.type = str;
    if (name === 'class') this.className = str;
    if (name === 'value') this.value = str;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  focus(): void {}
  blur(): void {}
  scrollIntoView(): void {}

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 32 };
  }

  click(): void {
    if (this.disabled) return;
    const evt = new FakeEvent('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(evt);
  }

  querySelectorAll(predicate: (el: FakeElement) => boolean): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeNode) => {
      if (node instanceof FakeElement && predicate(node)) {
        matches.push(node);
      }
      for (const child of node.childNodes) {
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  findButtonsByText(textSubstring: string): FakeElement[] {
    return this.querySelectorAll(
      (el) => el.tagName === 'BUTTON' && el.textContent.includes(textSubstring)
    );
  }
}

export class FakeEvent {
  public type: string;
  public bubbles: boolean;
  public cancelable: boolean;
  public defaultPrevented = false;
  public cancelBubble = false;
  public _stopped = false;
  public _stoppedImmediate = false;
  public target: any = null;
  public currentTarget: any = null;
  public timeStamp = Date.now();
  public button = 0;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.cancelBubble = true;
    this._stopped = true;
  }

  stopImmediatePropagation(): void {
    this.cancelBubble = true;
    this._stopped = true;
    this._stoppedImmediate = true;
  }
}

export class FakeDocument extends FakeNode {
  public documentElement: FakeElement;
  public head: FakeElement;
  public body: FakeElement;
  public cookie = '';
  public defaultView: any = null;

  constructor() {
    super(9, '#document', null);
    this.ownerDocument = this;
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.childNodes.push(this.documentElement);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(ns: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this, ns);
  }

  createTextNode(data: string): FakeNode {
    const node = new FakeNode(3, '#text', this);
    node.textContentValue = data == null ? '' : String(data);
    return node;
  }

  createComment(data: string): FakeNode {
    const node = new FakeNode(8, '#comment', this);
    node.textContentValue = data == null ? '' : String(data);
    return node;
  }

  createDocumentFragment(): FakeNode {
    return new FakeNode(11, '#document-fragment', this);
  }

  get activeElement(): FakeElement {
    return this.body;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches: FakeElement[] = [];
    const visit = (node: FakeNode) => {
      if (node instanceof FakeElement && node.tagName.toLowerCase() === selector.toLowerCase()) {
        matches.push(node);
      }
      for (const child of node.childNodes) {
        visit(child);
      }
    };
    visit(this.body);
    return matches;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class FakeIFrameElement extends FakeElement {
  public contentWindow: any = null;
  constructor(ownerDocument: FakeDocument) {
    super('iframe', ownerDocument);
  }
}

export function installFakeDomEnvironment() {
  const doc = new FakeDocument();
  const winListeners = new Map<string, Set<(e: any) => void>>();

  const fakeWindow: any = {
    document: doc,
    location: {
      pathname: '/Sam_Att/',
      hash: '',
      href: 'https://localhost:4101/Sam_Att/',
      origin: 'https://localhost:4101',
    },
    history: {
      replaceState: () => {},
      pushState: () => {},
    },
    navigator: { userAgent: 'SamAttTestDOM/1.0' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: any) => clearTimeout(id),
    Event: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    CustomEvent: FakeEvent,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLButtonElement: FakeElement,
    HTMLIFrameElement: FakeIFrameElement,
    SVGElement: FakeElement,
    SVGSVGElement: FakeElement,
    addEventListener: (type: string, fn: (e: any) => void) => {
      let s = winListeners.get(type);
      if (!s) {
        s = new Set();
        winListeners.set(type, s);
      }
      s.add(fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: any) => {
      for (const fn of winListeners.get(event.type) ?? []) {
        fn(event);
      }
      return true;
    },
    localStorage: {
      _map: new Map<string, string>(),
      getItem(k: string) {
        return this._map.get(k) ?? null;
      },
      setItem(k: string, v: string) {
        this._map.set(k, String(v));
      },
      removeItem(k: string) {
        this._map.delete(k);
      },
    },
  };

  doc.defaultView = fakeWindow;

  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).window = fakeWindow;
  (globalThis as any).document = doc;
  (globalThis as any).Node = FakeNode;
  (globalThis as any).Element = FakeElement;
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLInputElement = FakeElement;
  (globalThis as any).HTMLButtonElement = FakeElement;
  (globalThis as any).HTMLIFrameElement = FakeIFrameElement;
  (globalThis as any).SVGElement = FakeElement;
  (globalThis as any).SVGSVGElement = FakeElement;
  (globalThis as any).Event = FakeEvent;
  (globalThis as any).MouseEvent = FakeEvent;
  (globalThis as any).localStorage = fakeWindow.localStorage;

  return {
    window: fakeWindow,
    document: doc,
    createContainer: () => {
      const container = doc.createElement('div');
      doc.body.appendChild(container);
      return container;
    },
  };
}
