export interface TemplateContext {
  readonly now: Date;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}
