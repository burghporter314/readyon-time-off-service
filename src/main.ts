import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Global validation: strip unknown fields, forbid them, coerce types
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('ReadyOn Time-Off API')
    .setDescription(
      'Manages worker availability blocking for the ReadyOn frontline workforce scheduling platform. ' +
        'Workers self-select shifts; time off blocks availability windows so the AI scheduling engine ' +
        'stops offering shift slots to unavailable workers. ' +
        'GET /balances is the highest-frequency endpoint — consumed by the scheduling engine on every shift-matching cycle.',
    )
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`ReadyOn Time-Off Service running on http://localhost:${port}`);
  console.log(`Swagger docs at http://localhost:${port}/api-docs`);
}

bootstrap();
