import { env } from 'cloudflare:workers';
import { handleGameRequest } from '../../../../online/game-service.mjs';
export const dynamic = 'force-dynamic';
export function GET(request:Request) {return handleGameRequest(request,env.DB);}
export function POST(request:Request) {return handleGameRequest(request,env.DB);}
