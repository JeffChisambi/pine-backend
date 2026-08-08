import { IsNotEmpty, IsString, IsUUID, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SubmitBankAccountDto {
  @ApiProperty({ description: 'KYC application ID' })
  @IsUUID()
  applicationId: string;

  @ApiProperty({ description: 'Name of the bank', example: 'National Bank of Malawi' })
  @IsString()
  @IsNotEmpty()
  bankName: string;

  @ApiProperty({ description: 'Account number (10-20 digits)', example: '1234567890' })
  @IsString()
  @Matches(/^\d{10,20}$/, { message: 'accountNumber must be 10-20 digits' })
  accountNumber: string;

  @ApiProperty({ description: 'Account holder name', example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  accountName: string;
}
