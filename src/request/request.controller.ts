import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequestService } from './request.service';
import { CreateRequestDto } from './create-request.dto';

@ApiTags('requests')
@Controller('requests')
export class RequestController {
  constructor(private readonly requestService: RequestService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Submit a time-off request (blocks availability window)' })
  @ApiHeader({
    name: 'Idempotency-Key',
    description: 'UUID for idempotent submission',
    required: false,
  })
  @ApiResponse({ status: 201, description: 'Request created' })
  @ApiResponse({ status: 400, description: 'Invalid body' })
  @ApiResponse({ status: 404, description: 'Balance not found' })
  @ApiResponse({ status: 409, description: 'Duplicate idempotency key in flight' })
  @ApiResponse({ status: 422, description: 'Insufficient balance' })
  submit(
    @Body() dto: CreateRequestDto,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ) {
    return this.requestService.submit(dto, idempotencyKey);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a time-off request by ID' })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Request found' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  findById(@Param('id') id: string) {
    return this.requestService.findById(id);
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approve a pending time-off request' })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Request approved' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 409, description: 'Invalid status for this transition' })
  approve(@Param('id') id: string) {
    return this.requestService.approve(id);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject a pending time-off request' })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Request rejected' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 409, description: 'Invalid status for this transition' })
  reject(@Param('id') id: string) {
    return this.requestService.reject(id);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel a pending time-off request' })
  @ApiParam({ name: 'id', description: 'Request UUID' })
  @ApiResponse({ status: 200, description: 'Request cancelled' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  @ApiResponse({ status: 409, description: 'Invalid status for this transition' })
  cancel(@Param('id') id: string) {
    return this.requestService.cancel(id);
  }
}
