const AWS = require('aws-sdk');
import {ErrorTypes, GeneratedError} from './responses';

const dynamo = new AWS.DynamoDB.DocumentClient();

interface DynamoDBRetrievalParams {
    TableName: string,
    ProjectionExpression: string,
    IndexName?: string,
    ExpressionAttributeNames?: object,
    ConsistentRead?: boolean;
}
export interface DynamoDBGetParams extends DynamoDBRetrievalParams {
    Key: object
}

export interface DynamoDBQueryParams extends DynamoDBRetrievalParams {
    KeyConditionExpression: string,
    ExpressionAttributeValues: object
}

export interface DynamoDBScanParams extends DynamoDBRetrievalParams {
    FilterExpression: string,
    ExpressionAttributeValues: object
}

export const performQuery = async (request: DynamoDBQueryParams): Promise<any[]> => {
    let result:any = await dynamo.query(request).promise();
    if(!result.Items) {
        throw new GeneratedError(ErrorTypes.InvalidDatabaseRequest);
    }
    return result.Items;
}

export const performScan = async (request: DynamoDBScanParams): Promise<any[]> => {
    let result:any = await dynamo.scan(request).promise();
    if(!result.Items) {
        throw new GeneratedError(ErrorTypes.InvalidDatabaseRequest);
    }
    return result.Items;
}

export const performGet = async (request: DynamoDBGetParams): Promise<any> => {
    let result: any = await dynamo.get(request).promise();
    if(!result.Item) {
        throw new GeneratedError(ErrorTypes.InvalidDatabaseRequest);
    }
    return result.Item;
}

export interface DynamoDBUpdateParams {
    TableName: string,
    Key: object,
    UpdateExpression: string,
    ExpressionAttributeValues?: object,
    ExpressionAttributeNames?: object,
    ReturnValues?: string,
    ConditionExpression?: string
}

export const performUpdate = async (request: DynamoDBUpdateParams): Promise<any> => {
    return await dynamo.update(request).promise();
}

export const updateUser = async (id: string, UpdateExpression: string, ExpressionAttributeValues: object) => {
    const updateAdminStatus: DynamoDBUpdateParams = {
        TableName: process.env.USER_TABLE,
        Key: {id},
        UpdateExpression: UpdateExpression,
        ExpressionAttributeValues: ExpressionAttributeValues
    }
    await performUpdate(updateAdminStatus)
}

export interface DynamoDBPutParams {
    TableName: string,
    Item: object
}

export const performPut = async (request: DynamoDBPutParams): Promise<any> => {
    return await dynamo.put(request).promise();
}

export interface DynamoDBDeleteParams {
    TableName: string,
    Key: object,
    ReturnValues?: string
}

export const performDelete = async (request: DynamoDBDeleteParams): Promise<any> => {
    return await dynamo.delete(request).promise();
}