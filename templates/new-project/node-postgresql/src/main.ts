import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { AppModule } from './app.module.js'

function port(): number { const value = Number(process.env.PORT ?? '3000'); if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('PORT must be a valid TCP port'); return value }
const app = await NestFactory.create(AppModule, { bufferLogs: true })
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Service').setVersion('1.0').build()))
app.enableShutdownHooks()
await app.listen(port(), '127.0.0.1')
