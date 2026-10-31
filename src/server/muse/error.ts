export class PrivateError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
