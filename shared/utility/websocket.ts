import { APIGatewayEvent } from "aws-lambda";
import { ListWrapper } from "./list";

const AWS = require('aws-sdk');

let apigwManagementApi;

export enum WebSocketMessages{
    InitalizeSession = 'initSession',
    SetPosition = 'setPos',
    CloseListSession = 'closeListSession',
    UpdateListStatus = 'updateListStatus',
    HelpEvent = 'helpEvent',
    HelperEvent = 'helperEvent',
    FlagRecorded = 'flagRecorded',
    FullInfo = 'fullInfo'
}

const initApi = (_: APIGatewayEvent) => {
    if(!apigwManagementApi) {
        apigwManagementApi = new AWS.ApiGatewayManagementApi({
            apiVersion: '2018-11-29',
            endpoint: process.env.WEB_DOMAIN
        });
    }
}

export const sendMessageToUser = async (userId: string, connectionId: string, message: any, messageType: WebSocketMessages, event: APIGatewayEvent, list: ListWrapper) => {
    if(connectionId) {
        initApi(event);
        try {
            await apigwManagementApi.postToConnection({ ConnectionId: connectionId, Data: JSON.stringify({messageType, message}) }).promise();
        } catch (e) {
            if (e.statusCode === 410) {
                await list.removeConnectionForUser(userId, connectionId);
            }
        }
    }
}