export class WheelsAIError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "WheelsAIError";
    this.status = status;
    this.data = data;
  }
}
