import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddXFeedSubscriptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  username!: string;
}
