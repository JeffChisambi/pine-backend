import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SaveCardDto {
  @ApiProperty({
    description: 'Card number (digits only, 13-19 digits)',
    example: '4111111111111111',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{13,19}$/, { message: 'cardNumber must be 13-19 digits' })
  cardNumber: string;

  @ApiProperty({
    description: 'Cardholder name as it appears on the card',
    example: 'JOHN DOE',
  })
  @IsString()
  @IsNotEmpty()
  cardholderName: string;

  @ApiProperty({
    description: 'Expiry month (01-12)',
    example: '12',
  })
  @IsString()
  @Matches(/^\d{2}$/, { message: 'expiryMonth must be a 2-digit month' })
  expiryMonth: string;

  @ApiProperty({
    description: 'Expiry year (YY or YYYY)',
    example: '27',
  })
  @IsString()
  @Matches(/^\d{2,4}$/, { message: 'expiryYear must be YY or YYYY format' })
  expiryYear: string;
}
