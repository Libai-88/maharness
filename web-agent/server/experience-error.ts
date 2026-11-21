/** Error type shared by the experience service and its extracted modules. */
export class ExperienceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ExperienceError';
  }
}
