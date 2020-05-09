import { APIGatewayProxyEvent } from "aws-lambda";

export interface Response {
    statusCode: number,
    headers: Object,
    body: string
}

export enum ErrorTypes {
    General,
    InvalidInput,
    InvalidLogin,
    InvalidToken,
    InvalidPermissions,
    UserDoesNotExist,
    ClassDoesNotExist,
    InvalidDatabaseRequest,
    UserNotInClass,
    UsernameAlreadyExists,
    ConnectionNotInSession,
    SessionDoesNotExist,
    UserAlreadyInClass,
    TooManyRequests
}

export class GeneratedError extends Error {
    errorCode: ErrorTypes;

    constructor(error: ErrorTypes) {
        super(''+error)
        this.errorCode = error;
    }
}

const successfulResponse = (data: any): Response => {
    return {
        statusCode: 200,
        headers: {
            "Access-Control-Allow-Origin": "*" //Reduce in production
        },
        body: JSON.stringify(data)
    }
}

const failedResponse = (errorCode: ErrorTypes): Response => {
    return {
        statusCode: 500,
        headers: {
            "Access-Control-Allow-Origin": "*" //Reduce in production
        },
        body: JSON.stringify({errorCode})
    }
}
const parseInput = (event, websocket = false) => {
    try {
      const query = JSON.parse(event.body);
      if(query === null || typeof query !== 'object') {
        throw new GeneratedError(ErrorTypes.InvalidInput);
      }
      return websocket ? query.data : query;
    } catch (e) {
      throw new GeneratedError(ErrorTypes.InvalidInput);
    }
}
  

export const wrapper = async (event: APIGatewayProxyEvent, websocket: boolean, a: (query)=>any): Promise<Response> => {
    try {
        const query = parseInput(event, websocket);
        const result = await a(query);
        return successfulResponse({data:result});
    } catch (e) {
        console.log(e) //Remove in production
        if((e as GeneratedError).errorCode) {
            return failedResponse(e.errorCode);
        } else {
            return failedResponse(ErrorTypes.General)
        }
    }
}

