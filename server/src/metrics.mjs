function labelValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

export class Metrics {
  #startedAt = Date.now();
  #requests = new Map();
  #durations = new Map();
  #operations = new Map();

  request(method, route, status, durationMs) {
    const key = JSON.stringify([method, route, status]);
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    const durationKey = JSON.stringify([method, route]);
    const current = this.#durations.get(durationKey) ?? {count: 0, sum: 0};
    current.count += 1;
    current.sum += durationMs;
    this.#durations.set(durationKey, current);
  }

  operation(status) {
    this.#operations.set(status, (this.#operations.get(status) ?? 0) + 1);
  }

  render() {
    const lines = [
      '# HELP fieldnote_process_uptime_seconds Process uptime in seconds.',
      '# TYPE fieldnote_process_uptime_seconds gauge',
      `fieldnote_process_uptime_seconds ${((Date.now() - this.#startedAt) / 1000).toFixed(3)}`,
      '# HELP fieldnote_http_requests_total HTTP requests by normalized route and status.',
      '# TYPE fieldnote_http_requests_total counter',
    ];
    for (const [key, value] of [...this.#requests].sort()) {
      const [method, route, status] = JSON.parse(key);
      lines.push(`fieldnote_http_requests_total{method="${labelValue(method)}",route="${labelValue(route)}",status="${status}"} ${value}`);
    }
    lines.push('# HELP fieldnote_http_request_duration_ms HTTP request duration in milliseconds.');
    lines.push('# TYPE fieldnote_http_request_duration_ms summary');
    for (const [key, value] of [...this.#durations].sort()) {
      const [method, route] = JSON.parse(key);
      const labels = `method="${labelValue(method)}",route="${labelValue(route)}"`;
      lines.push(`fieldnote_http_request_duration_ms_sum{${labels}} ${value.sum.toFixed(3)}`);
      lines.push(`fieldnote_http_request_duration_ms_count{${labels}} ${value.count}`);
    }
    lines.push('# HELP fieldnote_sync_operations_total Durable operation results by ACK status.');
    lines.push('# TYPE fieldnote_sync_operations_total counter');
    for (const [status, value] of [...this.#operations].sort()) {
      lines.push(`fieldnote_sync_operations_total{status="${labelValue(status)}"} ${value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
