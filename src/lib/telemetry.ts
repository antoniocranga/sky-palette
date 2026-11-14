/**
 * OpenTelemetry (OTel) Tracing & Structured Observability for Cloudflare Workers
 * 
 * Conforms to OpenTelemetry semantic conventions and W3C Trace Context.
 * Emits structured JSON logs ingested by Cloudflare Workers Traces/Logs,
 * and supports asynchronous OTLP export via ctx.waitUntil().
 */

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
}

export interface OtelAttributes {
  [key: string]: string | number | boolean | undefined;
}

export class OtelTracker {
  private startTime: number;
  private traceId: string;
  private spanId: string;
  private serviceName: string;
  private environment: string;
  private attributes: OtelAttributes = {};

  constructor(request: Request, serviceName = 'sky-palette', environment = 'production') {
    this.startTime = performance.now();
    this.serviceName = serviceName;
    this.environment = environment;

    // Parse W3C traceparent or generate new trace/span IDs
    const traceparent = request.headers.get('traceparent');
    if (traceparent && traceparent.startsWith('00-')) {
      const parts = traceparent.split('-');
      this.traceId = parts[1] || this.randomHex(32);
      this.spanId = this.randomHex(16);
    } else {
      this.traceId = this.randomHex(32);
      this.spanId = this.randomHex(16);
    }

    this.setAttribute('http.method', request.method);
    this.setAttribute('http.url', request.url);
    this.setAttribute('colo', (request as any).cf?.colo || 'UNKNOWN');
    this.setAttribute('country', (request as any).cf?.country || 'UNKNOWN');
  }

  public getTraceId(): string {
    return this.traceId;
  }

  public getSpanId(): string {
    return this.spanId;
  }

  public getTraceparent(): string {
    return `00-${this.traceId}-${this.spanId}-01`;
  }

  public setAttribute(key: string, value: string | number | boolean | undefined): void {
    if (value !== undefined) {
      this.attributes[key] = value;
    }
  }

  public logInfo(message: string, extra?: OtelAttributes): void {
    this.emitLog('INFO', message, extra);
  }

  public logWarn(message: string, extra?: OtelAttributes): void {
    this.emitLog('WARN', message, extra);
  }

  public logError(message: string, error?: unknown, extra?: OtelAttributes): void {
    const errorAttrs: OtelAttributes = { ...extra };
    if (error instanceof Error) {
      errorAttrs['error.type'] = error.name;
      errorAttrs['error.message'] = error.message;
      if (error.stack) {
        errorAttrs['error.stack'] = error.stack;
      }
    } else if (error) {
      errorAttrs['error.message'] = String(error);
    }
    this.emitLog('ERROR', message, errorAttrs);
  }

  public complete(status: number, extra?: OtelAttributes): void {
    const duration = parseFloat((performance.now() - this.startTime).toFixed(2));
    this.setAttribute('http.status_code', status);
    this.setAttribute('duration_ms', duration);
    if (extra) {
      Object.assign(this.attributes, extra);
    }

    const payload = {
      timestamp: new Date().toISOString(),
      type: 'trace.span',
      service: {
        name: this.serviceName,
        version: '1.0.0',
        environment: this.environment
      },
      trace: {
        trace_id: this.traceId,
        span_id: this.spanId
      },
      duration_ms: duration,
      attributes: this.attributes
    };

    // Output structured JSON log for Cloudflare Workers Observability
    if (status >= 500) {
      console.error(JSON.stringify(payload));
    } else if (status >= 400) {
      console.warn(JSON.stringify(payload));
    } else {
      console.log(JSON.stringify(payload));
    }
  }

  public async exportOtlp(endpoint?: string, headersJson?: string): Promise<void> {
    if (!endpoint) return;
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(headersJson ? JSON.parse(headersJson) : {})
      };

      const otlpPayload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: this.serviceName } },
                { key: 'deployment.environment', value: { stringValue: this.environment } }
              ]
            },
            scopeSpans: [
              {
                scope: { name: 'sky-palette-edge', version: '1.0.0' },
                spans: [
                  {
                    traceId: this.traceId,
                    spanId: this.spanId,
                    name: `${this.attributes['http.method']} ${new URL(String(this.attributes['http.url'])).pathname}`,
                    kind: 1, // SPAN_KIND_INTERNAL
                    startTimeUnixNano: String(Math.floor((Date.now() - (this.attributes['duration_ms'] as number || 0)) * 1e6)),
                    endTimeUnixNano: String(Date.now() * 1e6),
                    attributes: Object.entries(this.attributes).map(([k, v]) => ({
                      key: k,
                      value: typeof v === 'number' ? { intValue: v } : { stringValue: String(v) }
                    })),
                    status: { code: (this.attributes['http.status_code'] as number) >= 400 ? 2 : 1 }
                  }
                ]
              }
            ]
          }
        ]
      };

      await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(otlpPayload)
      });
    } catch (err) {
      console.warn('[OtelExportFailed]', err instanceof Error ? err.message : String(err));
    }
  }

  private emitLog(severity: 'INFO' | 'WARN' | 'ERROR', message: string, extra?: OtelAttributes): void {
    const logEvent = {
      timestamp: new Date().toISOString(),
      severity,
      message,
      service: {
        name: this.serviceName,
        environment: this.environment
      },
      trace: {
        trace_id: this.traceId,
        span_id: this.spanId
      },
      attributes: {
        ...this.attributes,
        ...extra
      }
    };

    if (severity === 'ERROR') {
      console.error(JSON.stringify(logEvent));
    } else if (severity === 'WARN') {
      console.warn(JSON.stringify(logEvent));
    } else {
      console.log(JSON.stringify(logEvent));
    }
  }

  private randomHex(len: number): string {
    const bytes = new Uint8Array(len / 2);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
