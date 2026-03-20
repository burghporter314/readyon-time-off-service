import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsString,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

function IsAfterOrEqualDate(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isAfterOrEqualDate',
      target: (object as any).constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: any, args: ValidationArguments) {
          const [relatedPropertyName] = args.constraints;
          const relatedValue = (args.object as any)[relatedPropertyName];
          if (!value || !relatedValue) return true;
          return new Date(value) >= new Date(relatedValue);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be on or after ${args.constraints[0]}`;
        },
      },
    });
  };
}

export class CreateRequestDto {
  @ApiProperty({ example: 'emp001' })
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @ApiProperty({ example: 'loc001' })
  @IsString()
  @IsNotEmpty()
  locationId: string;

  @ApiProperty({ example: '2025-06-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2025-06-05' })
  @IsDateString()
  @IsAfterOrEqualDate('startDate', {
    message: 'endDate must be on or after startDate',
  })
  endDate: string;

  @ApiProperty({ example: 5 })
  @IsNumber()
  @Min(0.0001)
  daysRequested: number;
}
