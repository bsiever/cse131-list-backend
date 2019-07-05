// import { DynamoDBPutParams, performPut, DynamoDBDeleteParams, performDelete, performUpdate, DynamoDBUpdateParams, DynamoDBGetParams, performGet } from "./database";
// import { APIGatewayProxyEvent } from "aws-lambda";
// import { PermissionLevel, checkClassPermissions } from "./security";
// import { GeneratedError, ErrorTypes } from "./responses";
// import { isDate } from "util";

// const AWS = require('aws-sdk');
// require('aws-sdk/clients/apigatewaymanagementapi');

// const randtoken = require('rand-token');

// enum SessionListType {
//     HelpList = 'helpList',
//     DemoList = 'demoList',
//     Observer = 'observer'
// }
// type SessionUser = {
//     fullname: string,
//     list: SessionListType,
//     connectionId: string | null
// }
// type Session = {
//     lists: { [s in SessionListType]: string[]},
//     observers: string[],
//     participants: {[s: string]: SessionUser},
//     sessionName: string,
//     id: string,
//     classId: string,
//     version: number
// }

// enum MessageTypes{
//     CloseSession = 'closeSession'
// }

// const sendMessageToSessionMemebers = async (event: APIGatewayProxyEvent, sessionId: string, messageType: MessageTypes, recepients: {[s:string]: string}, body:any = {}): Promise<void> => {
//     //https://github.com/aws-samples/simple-websockets-chat-app/blob/master/sendmessage/app.js
//     const apigwManagementApi = new AWS.ApiGatewayManagementApi({
//         apiVersion: '2018-11-29',
//         endpoint: event.requestContext.domainName + '/' + event.requestContext.stage
//     });

//     await Promise.all(Object.entries(recepients).map(async ([userId, connectionId]) => {
//         try {
//             await apigwManagementApi.postToConnection({ ConnectionId: connectionId, Data: {messageType, body} }).promise();
//         } catch (e) {
//             if (e.statusCode === 410) {
//                 const updateRequest: DynamoDBUpdateParams = {
//                     TableName: process.env.SESSION_TABLE,
//                     Key: { sessionId },
//                     UpdateExpression: 'remove participants.#userId.connectionId',
//                     ConditionExpression: 'participants.#userId.connectionId = :valueToRemove',
//                     ExpressionAttributeNames: {
//                         '#userId': userId
//                     },
//                     ExpressionAttributeValues: {
//                         ':valueToRemove': connectionId
//                     }
//                 }
//                 await performUpdate(updateRequest);
//             }
//         }
//     }))
// }

// export const checkSessionPermissions = async (id: string, sessionId: string, classId: string, desiredPermissionLevel: PermissionLevel): Promise<PermissionLevel> => {
//     const level = await checkClassPermissions(id, classId, desiredPermissionLevel);

//     const getSessionClass: DynamoDBGetParams = {
//         TableName: process.env.SESSION_TABLE,
//         Key: {id: sessionId},
//         ProjectionExpression: 'classId'
//     }

//     const returnedSession: Session = await performGet(getSessionClass);

//     if(returnedSession.classId !== classId) {
//         throw new GeneratedError(ErrorTypes.InvalidPermissions)
//     }
//     return level
// }

// export const createClassSession = async (classId: string, newSessionName: string): Promise<void> => {
//     const newSession: Session = {
//         participants: {},
//         lists: {
//           'helpList' : [],
//           'demoList': []
//         },
//         observers: [],
//         sessionName: newSessionName,
//         id: randtoken.generate(32),
//         classId: classId,
//         version: 1
//     }
//     const request: DynamoDBPutParams = {
//         TableName: process.env.SESSION_TABLE,
//         Item: newSession
//     }
//     await performPut(request)
// }

// export const closeClassSession = async (event: APIGatewayProxyEvent, sessionId: string): Promise<void> => {
//     const closeSession: DynamoDBDeleteParams = {
//         TableName: process.env.SESSION_TABLE,
//         Key: {id: sessionId},
//         ReturnValues: 'ALL_OLD'
//     }
//     const oldSession = await performDelete(closeSession);
//     await sendMessageToSessionMemebers(event,sessionId,MessageTypes.CloseSession,oldSession.participants)
// }

// export const checkSessionStatus = async (id: string, userId: string, connectionId: string, fuzzy: boolean): Promise<any> => {
//     const getSessionStatus: DynamoDBGetParams = {
//         TableName: process.env.SESSION_TABLE,
//         Key: {id},
//         ProjectionExpression: 'participants.#id',
//         ExpressionAttributeNames: {
//             '#id': userId
//         }
//     }
//     const result = await performGet(getSessionStatus) as Session
//     if(result.participants[userId].connectionId === connectionId || fuzzy) {
//         return result.participants[userId];
//     } else {
//         throw new GeneratedError(ErrorTypes.ConnectionNotInSession)
//     }
// }

// export const getSessionLists = async (id: string) => {
//     const getLists: DynamoDBGetParams = {
//         TableName: process.env.SESSION_TABLE,
//         Key: {id},
//         ProjectionExpression: 'lists'
//     }
//     const lists = await performGet(getLists)
//     return Object.keys(lists.lists);
// }

// export const resumeSession = async (id: string, userId: string, connectionId: string): Promise<any> => {
//     const updateSessionUser: DynamoDBUpdateParams = {
//         TableName: process.env.SESSION_TABLE,
//         Key: {id},
//         UpdateExpression: 'set users.#id.connectionId = :connectionId',
//         ExpressionAttributeNames: {
//             '#id': userId
//         },
//         ExpressionAttributeValues: {
//             ':connectionId': connectionId
//         },
//         ReturnValues: 'ALL_NEW'
//     }
//     const table = await performUpdate(updateSessionUser) as Session
//     const list = table.participants[userId].list;
//     if(list === SessionListType.Observer) {
//         return {list};
//     } else {
//         return {list, position: table.lists[list].indexOf(userId)}
//     }
// }

// export const joinList = async (id: string, userId: string, list: SessionListType, connectionId: string, name: string): Promise<any> => {
//     const createSessionUser: DynamoDBUpdateParams = {
//         TableName: process.env.SESSION_TABLE,
//         Key: {id},
//         UpdateExpression: 'set participants.#userId = :data   set lists.#list = list_append(if_not_exists(lists.#list, :empty_list), :newUser)',
//         ExpressionAttributeNames: {
//             '#userId': userId,
//             '#list': list
//         },
//         ExpressionAttributeValues: {
//             ':data': {name, connectionId},
//             ':emptyList': [],
//             ':newUser': [userId] 
//         },
//         ReturnValues: 'UPDATED_NEW'
//     }
//     const results = await performUpdate(createSessionUser)
//     console.log(results)
//     return {list, position: results.lists[list].indexOf(userId)}
// }