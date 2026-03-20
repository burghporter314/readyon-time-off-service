import { HttpException, HttpStatus } from '@nestjs/common';

export class InsufficientBalanceException extends HttpException {
  constructor(available: number, requested: number) {
    super(
      {
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        error: 'INSUFFICIENT_BALANCE',
        message: `Insufficient balance: ${available} available, ${requested} requested`,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
