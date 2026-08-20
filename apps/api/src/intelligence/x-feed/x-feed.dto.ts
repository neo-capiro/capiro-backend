import { ArrayMaxSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';

export class AddXFeedSubscriptionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  username!: string;
}

export class ApplyXFeedDefaultsDto {
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  usernames!: string[];
}
