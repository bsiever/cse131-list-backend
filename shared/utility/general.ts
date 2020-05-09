import { DynamoDBUpdateParams, performUpdate } from "./database"

export const addClassToUser = async (userId: string, classId: string) => {
    const addToClass: DynamoDBUpdateParams = {
      TableName: process.env.USER_TABLE,
      Key: {id:userId}, //https://stackoverflow.com/questions/41400538/append-a-new-object-to-a-json-array-in-dynamodb-using-nodejs
      UpdateExpression: 'set #classes = list_append(if_not_exists(#classes, :empty_list), :newClass)',
      ExpressionAttributeNames: {
        '#classes' : 'classes'
      },
      ExpressionAttributeValues: {
        ':empty_list': [],
        ':newClass': [classId]
      }
    }
    await performUpdate(addToClass)
  }