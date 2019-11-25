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

export const wrapper = async (a: ()=>any): Promise<Response> => {
    try {
        const result = await a();
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